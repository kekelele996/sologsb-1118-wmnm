import type {
  PlannedReview,
  RelationReview,
  ReviewWarningKind,
  StratumRemap
} from '@/types/merge'
import type { Artifact, Relation, Stratum, Trench } from '@/types'
import { wouldCreateCycle } from '@/utils/graph'
import { uid } from '@/utils/id'

/** 单位号拆分结果：字母前缀 + 数字序号（如 L03 → L / 3 / 2） */
interface ParsedCode {
  prefix: string
  num: number
  width: number
}

/** 拆分「字母前缀 + 末尾数字」式单位号，无法拆出数字时返回 null */
export function parseUnitCode(code: string): ParsedCode | null {
  const text = code.trim().toUpperCase()
  const match = /^(.*?)(\d+)$/.exec(text)
  if (!match) return null
  return { prefix: match[1], num: Number(match[2]), width: match[2].length }
}

function codeKey(code: string): string {
  return code.trim().toUpperCase()
}

/** 同前缀同序号即视为重复（共存为无向关系，端点按字典序归并） */
export function relationDedupKey(relation: Pick<Relation, 'unitAId' | 'unitBId' | 'type'>): string {
  if (relation.type === '共存') {
    const pair = [relation.unitAId, relation.unitBId].sort()
    return `共存:${pair[0]}|${pair[1]}`
  }
  return `${relation.type}:${relation.unitAId}|${relation.unitBId}`
}

/** 按「保留方不动、被并方撞号才改」的原则给被并方单位重排单位号 */
export function remapStratumCodes(
  keeperTrench: Trench,
  absorbedTrench: Trench,
  strata: Stratum[]
): StratumRemap[] {
  const keeper = strata.filter((item) => item.trenchId === keeperTrench.id)
  const absorbed = strata.filter((item) => item.trenchId === absorbedTrench.id)

  const keeperCodes = new Set(keeper.map((item) => codeKey(item.code)))
  // 占用集合：保留方全部 + 被并方原始号；重排只在这个集合之外取号
  const claimed = new Set([
    ...keeper.map((item) => codeKey(item.code)),
    ...absorbed.map((item) => codeKey(item.code))
  ])
  // 各字母前缀已有的数字位宽，用于保持 L03 / H12 这类补零风格
  const prefixWidth = new Map<string, number>()
  const noteWidth = (code: string): void => {
    const parsed = parseUnitCode(code)
    if (!parsed) return
    prefixWidth.set(parsed.prefix, Math.max(prefixWidth.get(parsed.prefix) ?? 0, parsed.width))
  }
  keeper.forEach((item) => noteWidth(item.code))
  absorbed.forEach((item) => noteWidth(item.code))

  const absorbedCode = codeKey(absorbedTrench.code)
  const remaps: StratumRemap[] = []

  const allocateNumeric = (parsed: ParsedCode): string => {
    const width = Math.max(prefixWidth.get(parsed.prefix) ?? parsed.width, String(parsed.num).length)
    let num = 1
    for (;;) {
      const candidate = `${parsed.prefix}${String(num).padStart(width, '0')}`
      if (!claimed.has(candidate)) return candidate
      num += 1
    }
  }

  const allocateFallback = (oldKey: string): string => {
    let candidate = `${oldKey}-${absorbedCode}`
    let suffix = 2
    while (claimed.has(candidate)) {
      candidate = `${oldKey}-${absorbedCode}-${suffix}`
      suffix += 1
    }
    return candidate
  }

  // 同号单位按原号稳定排序，保证多次生成的方案一致
  const colliding = absorbed
    .filter((item) => keeperCodes.has(codeKey(item.code)))
    .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true }))

  colliding.forEach((stratum) => {
    const oldKey = codeKey(stratum.code)
    const parsed = parseUnitCode(stratum.code)
    const newCode = parsed ? allocateNumeric(parsed) : allocateFallback(oldKey)
    claimed.add(newCode)
    remaps.push({
      stratumId: stratum.id,
      oldCode: stratum.code.trim().toUpperCase(),
      newCode,
      formerCode: `${absorbedCode}:${stratum.code.trim().toUpperCase()}`
    })
  })

  return remaps
}

export interface MergePlan {
  remaps: StratumRemap[]
  plannedReviews: PlannedReview[]
  /** 被并方单位总数 / 撞号改号数 */
  absorbedUnitCount: number
  renamedCount: number
  /** 被隔离待裁定的跨方关系数 */
  spanningCount: number
}

export interface MergePlanInput {
  keeperTrench: Trench
  absorbedTrench: Trench
  strata: Stratum[]
  relations: Relation[]
}

/** 深度矛盾提示（与 useStratumOrder 的判定保持一致：A 叠压/打破 B 时 A 的上界不应更深） */
function depthWarning(relation: Pick<Relation, 'unitAId' | 'unitBId' | 'type'>, depthOf: Map<string, Stratum>): string | null {
  if (relation.type === '共存') return null
  const a = depthOf.get(relation.unitAId)
  const b = depthOf.get(relation.unitBId)
  if (!a || !b) return null
  if (a.topDepth > b.topDepth) {
    return `${a.code} ${relation.type} ${b.code}，但 ${a.code} 上界深度（${a.topDepth} m）大于 ${b.code}（${b.topDepth} m），与深度对不上`
  }
  return null
}

/**
 * 生成完整合并方案：
 * - 单位号撞号的按保留方重排（见 remapStratumCodes）；
 * - 跨两方的层位关系一律隔离为「待裁定」，并预判环路、深度矛盾、重复三种风险；
 * - 各方内部关系原样保留，不在此处改动。
 */
export function buildMergePlan(input: MergePlanInput): MergePlan {
  const { keeperTrench, absorbedTrench, strata, relations } = input
  const remaps = remapStratumCodes(keeperTrench, absorbedTrench, strata)

  const involvedIds = new Set(
    strata.filter((item) => item.trenchId === keeperTrench.id || item.trenchId === absorbedTrench.id).map((item) => item.id)
  )
  const depthOf = new Map(strata.map((item) => [item.id, item]))

  // 跨方关系：端点分属保留方与被并方；其余（各方内部、无关探方）原样保留
  const spanning = relations
    .filter((relation) => involvedIds.has(relation.unitAId) && involvedIds.has(relation.unitBId))
    .filter((relation) => {
      const trenchA = strata.find((item) => item.id === relation.unitAId)?.trenchId
      const trenchB = strata.find((item) => item.id === relation.unitBId)?.trenchId
      return trenchA !== undefined && trenchB !== undefined && trenchA !== trenchB
    })
    .sort((a, b) => a.id.localeCompare(b.id))

  // 模拟「全部采纳」的顺序累加，逐个预判环路；基准里保留各方内部关系
  const spanningIds = new Set(spanning.map((item) => item.id))
  const accepted: Relation[] = relations.filter((relation) => !spanningIds.has(relation.id))
  const seenKeys = new Set(accepted.map((item) => relationDedupKey(item)))

  const plannedReviews: PlannedReview[] = spanning.map((relation) => {
    const warnings: ReviewWarningKind[] = []
    const warningMessages: string[] = []

    if (seenKeys.has(relationDedupKey(relation))) {
      warnings.push('duplicate')
      warningMessages.push('与已有关系重复')
    }
    if (wouldCreateCycle(accepted, relation)) {
      warnings.push('cycle')
      warningMessages.push('采纳后会绕成环路（层位关系自相闭合）')
    }
    const depthMessage = depthWarning(relation, depthOf)
    if (depthMessage) {
      warnings.push('depthConflict')
      warningMessages.push(depthMessage)
    }

    accepted.push(relation)
    seenKeys.add(relationDedupKey(relation))

    return {
      id: uid('rv'),
      originalRelationId: relation.id,
      unitAId: relation.unitAId,
      unitBId: relation.unitBId,
      type: relation.type,
      basis: relation.basis,
      recorder: relation.recorder,
      note: relation.note,
      warnings,
      warningMessages
    }
  })

  const absorbedUnitCount = strata.filter((item) => item.trenchId === absorbedTrench.id).length

  return {
    remaps,
    plannedReviews,
    absorbedUnitCount,
    renamedCount: remaps.length,
    spanningCount: plannedReviews.length
  }
}

/** 稳定序列化（按 id 排序后 JSON 化），用于合并前后数据比对 */
function stableStringify(rows: { id: string }[]): string {
  return JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)))
}

/** 合并涉及数据的指纹：两个探方及其单位、出土物、关系 */
export function snapshotFingerprint(input: {
  trenches: Trench[]
  strata: Stratum[]
  artifacts: Artifact[]
  relations: Relation[]
  keeperTrenchId: string
  absorbedTrenchId: string
}): { trenches: string; strata: string; artifacts: string; relations: string } {
  const trenchIds = new Set([input.keeperTrenchId, input.absorbedTrenchId])
  const trenches = input.trenches.filter((item) => trenchIds.has(item.id))
  const stratumIds = new Set(input.strata.filter((item) => trenchIds.has(item.trenchId)).map((item) => item.id))
  const artifacts = input.artifacts.filter((item) => stratumIds.has(item.stratumId))
  const relations = input.relations.filter((item) => stratumIds.has(item.unitAId) || stratumIds.has(item.unitBId))
  return {
    trenches: stableStringify(trenches),
    strata: stableStringify(input.strata.filter((item) => stratumIds.has(item.id))),
    artifacts: stableStringify(artifacts),
    relations: stableStringify(relations)
  }
}

/**
 * 断点继续前的方案漂移检测：
 * 草稿记录的两个探方当前数据若与快照不一致（中途有人增删改），旧方案不能硬套。
 */
export function detectPlanDrift(
  snapshotFingerprints: MergeSnapshotFingerprints,
  current: {
    trenches: Trench[]
    strata: Stratum[]
    artifacts: Artifact[]
    relations: Relation[]
  },
  keeperTrenchId: string,
  absorbedTrenchId: string
): string | null {
  const keeper = current.trenches.find((item) => item.id === keeperTrenchId)
  if (!keeper) return '保留方探方已不存在，原方案无法继续'
  const absorbed = current.trenches.find((item) => item.id === absorbedTrenchId)
  if (!absorbed) return '被并方探方已不存在（可能已被别的操作删除或合并），请重新制定方案'

  const now = snapshotFingerprint({ ...current, keeperTrenchId, absorbedTrenchId })
  const checks: [keyof MergeSnapshotFingerprints, string][] = [
    ['trenches', '探方记录'],
    ['strata', '地层单位'],
    ['artifacts', '出土物'],
    ['relations', '层位关系']
  ]
  const changed = checks.filter(([key]) => now[key] !== snapshotFingerprints[key]).map(([, label]) => label)
  if (changed.length > 0) return `方案制定后${changed.join('、')}有变动，请重新制定合并方案`
  return null
}

type MergeSnapshotFingerprints = ReturnType<typeof snapshotFingerprint>

/** 采纳前校验：返回阻断原因（重复 / 环路）；深度矛盾不阻断，由整理员确认 */
export function reviewBlockingReason(
  activeRelations: Relation[],
  candidate: Pick<Relation, 'unitAId' | 'unitBId' | 'type'>
): string | null {
  const key = relationDedupKey(candidate)
  if (activeRelations.some((item) => relationDedupKey(item) === key)) {
    return '已有相同关系，采纳会造成重复'
  }
  if (wouldCreateCycle(activeRelations, candidate)) {
    return '采纳后会绕成环路（层位关系自相闭合）'
  }
  return null
}

/** 采纳时的深度矛盾提示文案（不阻断） */
export function reviewDepthNote(review: Pick<RelationReview, 'unitAId' | 'unitBId' | 'type'>, strata: Stratum[]): string | null {
  const depthOf = new Map(strata.map((item) => [item.id, item]))
  return depthWarning(review, depthOf)
}
