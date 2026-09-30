import type { MergeJob, Relation, RelationReview } from '@/types'
import { db } from '@/hooks/usePersistentStore'
import { uid } from '@/utils/id'
import { detectPlanDrift, reviewBlockingReason, snapshotFingerprint, type MergePlan } from '@/utils/mergePlan'

function nowText(): string {
  return new Date().toISOString()
}

export interface ExecuteResult {
  ok: boolean
  job?: MergeJob
  error?: string
}

/**
 * 创建合并草稿：落盘改号方案、待裁定关系与合并前快照。
 * 方案由调用方先用 buildMergePlan 生成（页面预览同一份），草稿不改动任何业务数据。
 */
export async function createMergeDraft(
  keeperTrenchId: string,
  absorbedTrenchId: string,
  plan: MergePlan
): Promise<MergeJob> {
  if (keeperTrenchId === absorbedTrenchId) {
    throw new Error('保留方与被并方不能是同一个探方')
  }
  const [keeper, absorbed, trenches, strata, artifacts, relations] = await Promise.all([
    db.trenches.get(keeperTrenchId),
    db.trenches.get(absorbedTrenchId),
    db.trenches.toArray(),
    db.strata.toArray(),
    db.artifacts.toArray(),
    db.relations.toArray()
  ])
  if (!keeper) throw new Error('保留方探方不存在')
  if (!absorbed) throw new Error('被并方探方不存在')

  const existing = await db.mergeJobs
    .where('status')
    .equals('draft')
    .toArray()
  const blocked = existing.find(
    (item) =>
      item.keeperTrenchId === keeperTrenchId ||
      item.keeperTrenchId === absorbedTrenchId ||
      item.absorbedTrenchId === keeperTrenchId ||
      item.absorbedTrenchId === absorbedTrenchId
  )
  if (blocked) {
    throw new Error(`已有未完成的合并草稿涉及这两个探方（${blocked.keeperCode} 与 ${blocked.absorbedCode}），请先继续或废弃它`)
  }

  const involvedStratumIds = new Set(
    strata.filter((item) => item.trenchId === keeperTrenchId || item.trenchId === absorbedTrenchId).map((item) => item.id)
  )
  const snapshot = {
    trenches: trenches.filter((item) => item.id === keeperTrenchId || item.id === absorbedTrenchId),
    strata: strata.filter((item) => involvedStratumIds.has(item.id)),
    artifacts: artifacts.filter((item) => involvedStratumIds.has(item.stratumId)),
    relations: relations.filter((item) => involvedStratumIds.has(item.unitAId) || involvedStratumIds.has(item.unitBId))
  }

  const timestamp = nowText()
  const job: MergeJob = {
    id: uid('mj'),
    status: 'draft',
    keeperTrenchId,
    absorbedTrenchId,
    keeperCode: keeper.code,
    absorbedCode: absorbed.code,
    remaps: plan.remaps,
    plannedReviews: plan.plannedReviews,
    snapshot,
    createdAt: timestamp,
    updatedAt: timestamp
  }
  await db.mergeJobs.put(job)
  return job
}

/**
 * 执行合并：全部写入放在同一个 Dexie 读写事务里，
 * 任一步失败 IndexedDB 自动回滚——两个探方都恢复成合并前的样子，草稿保留以便重开续并。
 */
export async function executeMergeJob(jobId: string): Promise<ExecuteResult> {
  const job = await db.mergeJobs.get(jobId)
  if (!job) return { ok: false, error: '合并草稿不存在（可能已被删除）' }
  if (job.status === 'done') return { ok: false, job, error: '该合并任务已经完成' }

  const [trenches, strata, artifacts, relations] = await Promise.all([
    db.trenches.toArray(),
    db.strata.toArray(),
    db.artifacts.toArray(),
    db.relations.toArray()
  ])
  const drift = detectPlanDrift(
    snapshotFingerprint({
      trenches: job.snapshot.trenches,
      strata: job.snapshot.strata,
      artifacts: job.snapshot.artifacts,
      relations: job.snapshot.relations,
      keeperTrenchId: job.keeperTrenchId,
      absorbedTrenchId: job.absorbedTrenchId
    }),
    { trenches, strata, artifacts, relations },
    job.keeperTrenchId,
    job.absorbedTrenchId
  )
  if (drift) {
    const updated = { ...job, lastError: drift, updatedAt: nowText() }
    await db.mergeJobs.put(updated)
    return { ok: false, job: updated, error: drift }
  }

  const keeper = trenches.find((item) => item.id === job.keeperTrenchId) as NonNullable<(typeof trenches)[number]>
  const absorbedTrench = trenches.find((item) => item.id === job.absorbedTrenchId) as NonNullable<(typeof trenches)[number]>
  const remapByStratum = new Map(job.remaps.map((item) => [item.stratumId, item]))
  const timestamp = nowText()

  try {
    const updatedJob = await db.transaction('rw', db.trenches, db.strata, db.relations, db.relationReviews, db.mergeJobs, async () => {
      // 1. 保留方探方：登记并进来的探方号，四壁备注追加被并方记录
      const mergedFromCodes = [...(keeper.mergedFromCodes ?? []), absorbedTrench.code.trim().toUpperCase()]
      const wallNote = absorbedTrench.wallNote.trim()
        ? [keeper.wallNote.trim(), `【合并自 ${absorbedTrench.code}】${absorbedTrench.wallNote.trim()}`]
            .filter(Boolean)
            .join('\n')
        : keeper.wallNote
      await db.trenches.put({ ...keeper, wallNote, mergedFromCodes })

      // 2. 被并方单位并入保留方；撞号的按方案改号并登记曾用号（器物不改动，只靠 stratumId 跟随）
      await Promise.all(
        strata
          .filter((item) => item.trenchId === job.absorbedTrenchId)
          .map((item) => {
            const remap = remapByStratum.get(item.id)
            const formerCodes = remap ? [...(item.formerCodes ?? []), remap.formerCode] : item.formerCodes ?? []
            return db.strata.put({
              ...item,
              trenchId: job.keeperTrenchId,
              code: remap ? remap.newCode : item.code,
              formerCodes
            })
          })
      )

      // 3. 被并方探方删除
      await db.trenches.delete(job.absorbedTrenchId)

      // 4. 跨方关系从正式关系表移走，进入待裁定（不硬写进图）
      await Promise.all(job.plannedReviews.map((item) => db.relations.delete(item.originalRelationId)))
      const reviews: RelationReview[] = job.plannedReviews.map((item) => ({
        ...item,
        mergeJobId: job.id,
        status: 'pending',
        createdAt: timestamp
      }))
      await db.relationReviews.bulkPut(reviews)

      // 5. 任务标记完成，留存审计
      const done: MergeJob = {
        ...job,
        status: 'done',
        lastError: undefined,
        updatedAt: timestamp,
        completedAt: timestamp
      }
      await db.mergeJobs.put(done)
      return done
    })
    return { ok: true, job: updatedJob }
  } catch (cause) {
    // 事务已整体回滚：两个探方与合并前一致；仅把失败原因写到草稿上，重开还能接着再并
    const message = cause instanceof Error ? cause.message : String(cause)
    const failed = { ...job, lastError: message, updatedAt: nowText() }
    await db.mergeJobs.put(failed)
    return { ok: false, job: failed, error: message }
  }
}

/** 废弃未完成的合并草稿（只删草稿本身，业务数据从未被它改动） */
export async function discardMergeJob(jobId: string): Promise<void> {
  const job = await db.mergeJobs.get(jobId)
  if (job && job.status === 'draft') {
    await db.mergeJobs.delete(jobId)
  }
}

export interface ReviewDecision {
  ok: boolean
  reason?: string
}

/** 整理员采纳待裁定关系：重复 / 环路阻断；深度矛盾不阻断（采纳前在界面确认） */
export async function acceptReview(reviewId: string): Promise<ReviewDecision> {
  const review = await db.relationReviews.get(reviewId)
  if (!review) return { ok: false, reason: '待裁定记录不存在' }
  if (review.status !== 'pending') return { ok: false, reason: '该关系已处置' }

  const activeRelations = await db.relations.toArray()
  const candidate: Pick<Relation, 'unitAId' | 'unitBId' | 'type'> = {
    unitAId: review.unitAId,
    unitBId: review.unitBId,
    type: review.type
  }
  const blocked = reviewBlockingReason(activeRelations, candidate)
  if (blocked) return { ok: false, reason: blocked }

  const timestamp = nowText()
  await db.transaction('rw', db.relations, db.relationReviews, async () => {
    // 沿用原关系 id，保持引用身份稳定
    const relation: Relation = {
      id: review.originalRelationId,
      unitAId: review.unitAId,
      unitBId: review.unitBId,
      type: review.type,
      basis: review.basis,
      recorder: review.recorder,
      note: review.note
    }
    await db.relations.put(relation)
    await db.relationReviews.put({ ...review, status: 'accepted', decidedAt: timestamp })
  })
  return { ok: true }
}

/** 整理员放弃待裁定关系：不写入正式关系表 */
export async function discardReview(reviewId: string): Promise<void> {
  const review = await db.relationReviews.get(reviewId)
  if (!review || review.status !== 'pending') return
  await db.relationReviews.put({ ...review, status: 'discarded', decidedAt: nowText() })
}
