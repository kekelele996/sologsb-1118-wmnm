import type { Artifact, Relation, Stratum, Trench } from '@/types'
import { db } from '@/hooks/usePersistentStore'

/** 撞号重排记录：被并方单位原号 → 保留方新号 */
export interface RenumberChange {
  stratumId: string
  from: string
  to: string
}

/** 探方合并方案 */
export interface MergePlan {
  /** 保留方（合并后保留其编号与记录） */
  retained: Trench
  /** 被并方（记录并入后删除） */
  mergedAway: Trench
  /** 单位号撞号重排清单（仅撞号的单位） */
  renumbers: RenumberChange[]
  /** 合入后可直接保留的跨方关系 */
  keptRelations: Relation[]
  /** 需整理员定夺的跨方关系（合入后可能绕圈或与深度矛盾，暂置 pending） */
  pendingRelations: Relation[]
}

/** 合并执行结果 */
export interface MergeResult {
  retained: Trench
  mergedAway: Trench
  renumbered: RenumberChange[]
  keptCount: number
  pendingCount: number
}

/** 解析单位号的前缀与数字段，如 L03 → { prefix: 'L', num: 3, numStr: '03' } */
function parseCode(code: string): { prefix: string; num: number; numStr: string } | null {
  const match = code.trim().toUpperCase().match(/^(\D*)(\d+)$/)
  if (!match) return null
  return { prefix: match[1], num: parseInt(match[2], 10), numStr: match[2] }
}

/**
 * 在已占用编号范围内，为撞号单位找一个不撞的新号。
 * 取同前缀已有最大序号之后顺延（仅重排真正撞号的单位，避免连环改号），保留原前缀与位宽。
 */
export function nextAvailableCode(code: string, occupied: Set<string>): string {
  const parsed = parseCode(code)
  if (!parsed) {
    // 无数字段：追加序号后缀
    const base = code.trim().toUpperCase()
    let n = 2
    while (occupied.has(`${base}${n}`)) n += 1
    return `${base}${n}`
  }
  const { prefix, num, numStr } = parsed
  const width = numStr.length
  let max = num
  occupied.forEach((key) => {
    const p = parseCode(key)
    if (p && p.prefix === prefix && p.num > max) max = p.num
  })
  let n = max + 1
  while (occupied.has(`${prefix}${String(n).padStart(width, '0')}`)) n += 1
  return `${prefix}${String(n).padStart(width, '0')}`
}

/** 在邻接表中判断从 start 出发能否到达 target（用于判断新增边是否闭合环路） */
function reaches(adjacency: Map<string, string[]>, start: string, target: string): boolean {
  if (start === target) return true
  const visited = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const node = stack.pop() as string
    if (node === target) return true
    if (visited.has(node)) continue
    visited.add(node)
    for (const next of adjacency.get(node) ?? []) {
      if (!visited.has(next)) stack.push(next)
    }
  }
  return false
}

/** 层位关系是否与深度矛盾：叠压/打破关系中 A 的上界深于 B 即矛盾 */
function depthConflict(strata: Stratum[], relation: Relation): boolean {
  if (relation.type === '共存') return false
  const a = strata.find((item) => item.id === relation.unitAId)
  const b = strata.find((item) => item.id === relation.unitBId)
  return !!a && !!b && a.topDepth > b.topDepth
}

/**
 * 生成探方合并方案：
 * - 被并方单位号与保留方撞号的，按保留方序号重排，原号留作曾用号；
 * - 跨方关系逐条核验：合入后会绕成圈或与深度对不上的，挂起交整理员定夺，不硬写。
 */
export function buildMergePlan(
  retained: Trench,
  mergedAway: Trench,
  strata: Stratum[],
  relations: Relation[]
): MergePlan {
  const retainedStrata = strata.filter((item) => item.trenchId === retained.id)
  const awayStrata = strata.filter((item) => item.trenchId === mergedAway.id)
  const awayIds = new Set(awayStrata.map((item) => item.id))
  const retainedIds = new Set(retainedStrata.map((item) => item.id))

  // 1) 单位号撞号重排：仅与保留方撞号的单位按保留方序号重排，原号留作曾用号
  const retainedCodes = new Set(retainedStrata.map((item) => item.code.trim().toUpperCase()))
  const occupied = new Set<string>()
  strata.forEach((item) => occupied.add(item.code.trim().toUpperCase()))
  const renumbers: RenumberChange[] = []
  for (const item of awayStrata) {
    const key = item.code.trim().toUpperCase()
    if (retainedCodes.has(key)) {
      const to = nextAvailableCode(item.code, occupied)
      occupied.add(to)
      renumbers.push({ stratumId: item.id, from: item.code, to })
    }
  }

  // 2) 跨方关系分类：先以合入后的全部非挂起关系构建邻接
  const adjacency = new Map<string, string[]>()
  strata.forEach((item) => adjacency.set(item.id, []))
  const pushEdge = (from: string, to: string): void => {
    if (!adjacency.has(from) || !adjacency.has(to)) return
    adjacency.get(from)?.push(to)
  }
  relations
    .filter((item) => !item.pending)
    .forEach((item) => {
      pushEdge(item.unitAId, item.unitBId)
      if (item.type === '共存') pushEdge(item.unitBId, item.unitAId)
    })

  const keptRelations: Relation[] = []
  const pendingRelations: Relation[] = []
  for (const item of relations) {
    if (item.pending) continue
    const cross =
      (awayIds.has(item.unitAId) && retainedIds.has(item.unitBId)) ||
      (retainedIds.has(item.unitAId) && awayIds.has(item.unitBId))
    if (!cross) continue // 探方内部关系不动

    const pendingReason = depthConflict(strata, item)
      ? '合入后 A 叠压/打破 B，但 A 的上界深度大于 B，层位关系与深度对不上'
      : null
    if (pendingReason) {
      pendingRelations.push({ ...item, pendingReason })
      continue
    }

    // 环路预判：A→B 闭合环路当且仅当图中已存在 B → … → A 的路径
    const createsCycle =
      item.type === '共存'
        ? reaches(adjacency, item.unitAId, item.unitBId) || reaches(adjacency, item.unitBId, item.unitAId)
        : reaches(adjacency, item.unitBId, item.unitAId)
    if (createsCycle) {
      pendingRelations.push({
        ...item,
        pendingReason: '合入后会与现有层位关系绕成闭合环路，层位关系不能自相矛盾'
      })
      continue
    }

    // 安全：加入邻接并保留
    pushEdge(item.unitAId, item.unitBId)
    if (item.type === '共存') pushEdge(item.unitBId, item.unitAId)
    keptRelations.push(item)
  }

  return { retained, mergedAway, renumbers, keptRelations, pendingRelations }
}

/** 合并两个探方的探方级记录：保留方为主体，吸收被并方的起止日期与四壁备注 */
function mergeTrenchRecords(retained: Trench, away: Trench): Trench {
  const startDate = [retained.startDate, away.startDate].filter(Boolean).sort()[0] ?? retained.startDate
  const ends = [retained.endDate, away.endDate].filter(Boolean).sort()
  const endDate = ends.length > 0 ? ends[ends.length - 1] : retained.endDate
  const notes = [retained.wallNote, away.wallNote].map((item) => item.trim()).filter(Boolean)
  const wallNote = Array.from(new Set(notes)).join('；')
  return { ...retained, startDate, endDate, wallNote }
}

/** 把四张表恢复成快照时的样子（合并失败兜底） */
async function restoreSnapshot(
  trenches: Trench[],
  strata: Stratum[],
  artifacts: Artifact[],
  relations: Relation[]
): Promise<void> {
  await db.transaction('rw', db.trenches, db.strata, db.artifacts, db.relations, async () => {
    await Promise.all([db.trenches.clear(), db.strata.clear(), db.artifacts.clear(), db.relations.clear()])
    await db.trenches.bulkPut(trenches)
    await db.strata.bulkPut(strata)
    await db.artifacts.bulkPut(artifacts)
    await db.relations.bulkPut(relations)
  })
}

/**
 * 执行探方合并。
 *
 * 全部写入在同一个 Dexie 读写事务内完成：中途任一步失败，事务回滚，
 * 两个探方及其下级记录恢复成合并前的样子；事务外再包一层快照兜底，
 * 保证重开后还能接着再并。
 *
 * 器物编号已贴在实物上，合并不改写器物编号，仅随单位改属保留方。
 */
export async function executeMerge(plan: MergePlan): Promise<MergeResult> {
  const { retained, mergedAway, renumbers, pendingRelations } = plan

  // 快照：合并前四张表全量记录
  const [oldTrenches, oldStrata, oldArtifacts, oldRelations] = await Promise.all([
    db.trenches.toArray(),
    db.strata.toArray(),
    db.artifacts.toArray(),
    db.relations.toArray()
  ])

  const renumberMap = new Map(renumbers.map((item) => [item.stratumId, item]))
  const pendingIds = new Set(pendingRelations.map((item) => item.id))

  try {
    await db.transaction('rw', db.trenches, db.strata, db.artifacts, db.relations, async () => {
      // 1) 被并方地层单位：改属保留方；撞号的按保留方重排，原号留作曾用号
      const awayStrata = oldStrata.filter((item) => item.trenchId === mergedAway.id)
      for (const item of awayStrata) {
        const change = renumberMap.get(item.id)
        await db.strata.put({
          ...item,
          trenchId: retained.id,
          code: change ? change.to : item.code,
          formerCode: change ? change.from : item.formerCode
        })
      }

      // 2) 跨方关系：合入后绕圈/与深度对不上的挂起，交整理员定夺；其余保持不动
      for (const item of pendingRelations) {
        await db.relations.put({
          ...item,
          pending: true,
          pendingReason:
            item.pendingReason ??
            `由探方 ${mergedAway.code} 并入 ${retained.code} 时挂起，请整理员复核后确认或删除`
        })
      }

      // 3) 保留方探方记录吸收被并方信息
      await db.trenches.put(mergeTrenchRecords(retained, mergedAway))

      // 4) 删除被并方探方（其下级单位已在第 1 步改属保留方）
      await db.trenches.delete(mergedAway.id)
    })
  } catch (error) {
    // 事务回滚后再兜底恢复一次，确保两个探方回到合并前
    await restoreSnapshot(oldTrenches, oldStrata, oldArtifacts, oldRelations).catch(() => undefined)
    throw error
  }

  return {
    retained,
    mergedAway,
    renumbered: renumbers,
    keptCount: plan.keptRelations.length,
    pendingCount: pendingIds.size
  }
}
