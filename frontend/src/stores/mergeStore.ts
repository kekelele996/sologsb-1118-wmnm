import { createStore } from 'zustand/vanilla'
import type { MergeJob, RelationReview } from '@/types'
import type { MergePlan } from '@/utils/mergePlan'
import { db, syncAll } from '@/hooks/usePersistentStore'
import {
  acceptReview,
  createMergeDraft,
  discardMergeJob,
  discardReview,
  executeMergeJob
} from '@/services/mergeService'

export interface MergeState {
  mergeJobs: MergeJob[]
  reviews: RelationReview[]
  loaded: boolean
  hydrate: () => Promise<void>
  createDraft: (keeperTrenchId: string, absorbedTrenchId: string, plan: MergePlan) => Promise<MergeJob>
  execute: (jobId: string) => Promise<{ ok: boolean; job?: MergeJob; error?: string }>
  discardJob: (jobId: string) => Promise<void>
  acceptReview: (reviewId: string) => Promise<{ ok: boolean; reason?: string }>
  discardReview: (reviewId: string) => Promise<void>
}

export const mergeStore = createStore<MergeState>((set, get) => ({
  mergeJobs: [],
  reviews: [],
  loaded: false,
  hydrate: async () => {
    const [mergeJobs, reviews] = await Promise.all([
      syncAll<MergeJob>(db.mergeJobs),
      syncAll<RelationReview>(db.relationReviews)
    ])
    mergeJobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    reviews.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    set({ mergeJobs, reviews, loaded: true })
  },
  createDraft: async (keeperTrenchId, absorbedTrenchId, plan) => {
    const job = await createMergeDraft(keeperTrenchId, absorbedTrenchId, plan)
    await get().hydrate()
    return job
  },
  execute: async (jobId) => {
    const result = await executeMergeJob(jobId)
    await get().hydrate()
    return result
  },
  discardJob: async (jobId) => {
    await discardMergeJob(jobId)
    await get().hydrate()
  },
  acceptReview: async (reviewId) => {
    const result = await acceptReview(reviewId)
    await get().hydrate()
    return result
  },
  discardReview: async (reviewId) => {
    await discardReview(reviewId)
    await get().hydrate()
  }
}))
