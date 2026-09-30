import type { Artifact, Relation, RelationBasis, RelationType, Stratum, Trench } from '@/types'

/** 合并任务状态：draft 可继续执行，done 为已完成（留存审计） */
export type MergeJobStatus = 'draft' | 'done'

/** 待裁定关系的处置状态 */
export type ReviewStatus = 'pending' | 'accepted' | 'discarded'

/** 跨方关系的预判风险类型 */
export type ReviewWarningKind = 'cycle' | 'depthConflict' | 'duplicate'

export interface ReviewWarning {
  kind: ReviewWarningKind
  message: string
}

/** 单个地层单位的改号映射 */
export interface StratumRemap {
  stratumId: string
  /** 改号前的单位号 */
  oldCode: string
  /** 重排后的新单位号 */
  newCode: string
  /** 登记为曾用号的文本，格式「被并探方号:原单位号」，如 T0502:L01 */
  formerCode: string
}

/** 生成方案时即确定的待裁定跨方关系（执行合并时落库到 relationReviews） */
export interface PlannedReview {
  /** 预分配的待裁定记录 id */
  id: string
  /** 原关系 id（采纳时沿用，保持身份稳定） */
  originalRelationId: string
  unitAId: string
  unitBId: string
  type: RelationType
  basis: RelationBasis
  recorder: string
  note: string
  warnings: ReviewWarningKind[]
  warningMessages: string[]
}

/** 已落库的待裁定跨方关系 */
export interface RelationReview extends PlannedReview {
  mergeJobId: string
  status: ReviewStatus
  createdAt: string
  decidedAt?: string
}

/** 合并前快照（用于审计与方案漂移检测） */
export interface MergeSnapshot {
  trenches: Trench[]
  strata: Stratum[]
  artifacts: Artifact[]
  relations: Relation[]
}

/** MergeJob 探方合并任务：草稿可断点继续，完成后留存审计 */
export interface MergeJob {
  id: string
  status: MergeJobStatus
  /** 保留方探方 id（编号以它为准） */
  keeperTrenchId: string
  /** 被并入方探方 id（合并后删除） */
  absorbedTrenchId: string
  /** 快照留存的探方号，便于源探方已被删除后展示 */
  keeperCode: string
  absorbedCode: string
  /** 单位改号方案 */
  remaps: StratumRemap[]
  /** 跨方关系待裁定方案 */
  plannedReviews: PlannedReview[]
  /** 合并前数据快照 */
  snapshot: MergeSnapshot
  createdAt: string
  updatedAt: string
  /** 最近一次执行失败的原因（草稿断点续并用） */
  lastError?: string
  completedAt?: string
}
