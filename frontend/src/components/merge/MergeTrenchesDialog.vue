<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { MergeJob, Stratum, Trench } from '@/types'
import { buildMergePlan, type MergePlan } from '@/utils/mergePlan'
import { useStore } from '@/hooks/usePersistentStore'
import { trenchStore } from '@/stores/trenchStore'
import { stratumStore } from '@/stores/stratumStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import { mergeStore } from '@/stores/mergeStore'

const props = defineProps<{
  modelValue: boolean
  /** 续并模式：传入未完成的合并任务 */
  job?: MergeJob | null
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'finished', job: MergeJob): void
}>()

const router = useRouter()
const trenchState = useStore(trenchStore)
const stratumState = useStore(stratumStore)
const artifactState = useStore(artifactStore)
const relationState = useStore(relationStore)

const step = ref(0)
const submitting = ref(false)
const form = reactive({ keeperTrenchId: '', absorbedTrenchId: '' })
const plan = ref<MergePlan | null>(null)
const activeJob = ref<MergeJob | null>(null)
const executing = ref(false)
const executeError = ref('')

const dialogVisible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

watch(
  () => props.modelValue,
  (visible) => {
    if (!visible) return
    if (props.job) {
      activeJob.value = props.job
      plan.value = {
        remaps: props.job.remaps,
        plannedReviews: props.job.plannedReviews,
        absorbedUnitCount: stratumState.strata.filter((item) => item.trenchId === props.job?.absorbedTrenchId).length,
        renamedCount: props.job.remaps.length,
        spanningCount: props.job.plannedReviews.length
      }
      executeError.value = props.job.lastError ?? ''
      step.value = 1
    } else {
      activeJob.value = null
      plan.value = null
      executeError.value = ''
      form.keeperTrenchId = ''
      form.absorbedTrenchId = ''
      step.value = 0
    }
  }
)

const keeperTrench = computed<Trench | null>(
  () => trenchState.trenches.find((item) => item.id === form.keeperTrenchId) ?? null
)
const absorbedTrench = computed<Trench | null>(
  () => trenchState.trenches.find((item) => item.id === form.absorbedTrenchId) ?? null
)

function unitsOf(trenchId: string): Stratum[] {
  return stratumState.strata.filter((item) => item.trenchId === trenchId)
}

function artifactsCountOf(trenchId: string): number {
  const ids = new Set(unitsOf(trenchId).map((item) => item.id))
  return artifactState.artifacts.filter((item) => ids.has(item.stratumId)).reduce((sum, item) => sum + item.count, 0)
}

function canGenerate(): boolean {
  return Boolean(form.keeperTrenchId && form.absorbedTrenchId && form.keeperTrenchId !== form.absorbedTrenchId)
}

async function generatePlan(): Promise<void> {
  if (!keeperTrench.value || !absorbedTrench.value) return
  submitting.value = true
  try {
    const nextPlan = buildMergePlan({
      keeperTrench: keeperTrench.value,
      absorbedTrench: absorbedTrench.value,
      strata: stratumState.strata,
      relations: relationState.relations
    })
    const job = await mergeStore.getState().createDraft(form.keeperTrenchId, form.absorbedTrenchId, nextPlan)
    activeJob.value = job
    plan.value = nextPlan
    executeError.value = ''
    step.value = 1
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '合并方案生成失败')
  } finally {
    submitting.value = false
  }
}

function stratumById(id: string): Stratum | null {
  return stratumState.strata.find((item) => item.id === id) ?? null
}

function unitText(id: string): string {
  const stratum = stratumById(id)
  if (!stratum) return '未知单位'
  const trench = trenchState.trenches.find((item) => item.id === stratum.trenchId)
  return `${trench ? trench.code : '未知探方'} · ${stratum.code}`
}

const warningType: Record<string, { label: string; type: 'danger' | 'warning' | 'info' }> = {
  cycle: { label: '环路', type: 'danger' },
  depthConflict: { label: '深度矛盾', type: 'warning' },
  duplicate: { label: '重复', type: 'info' }
}

async function runMerge(): Promise<void> {
  if (!activeJob.value) return
  executing.value = true
  executeError.value = ''
  const result = await mergeStore.getState().execute(activeJob.value.id)
  executing.value = false
  if (result.ok && result.job) {
    activeJob.value = result.job
    step.value = 2
    emit('finished', result.job)
  } else {
    executeError.value = result.error ?? '合并执行失败'
    activeJob.value = result.job ?? activeJob.value
  }
}

async function abandonDraft(): Promise<void> {
  if (!activeJob.value) return
  await ElMessageBox.confirm('废弃后该合并草稿将被删除（业务数据从未被草稿改动），确认废弃？', '废弃合并草稿', {
    type: 'warning'
  })
  await mergeStore.getState().discardJob(activeJob.value.id)
  ElMessage.success('合并草稿已废弃')
  dialogVisible.value = false
}

function goRelations(): void {
  dialogVisible.value = false
  void router.push('/relations')
}
</script>

<template>
  <el-dialog
    v-model="dialogVisible"
    :title="job ? `继续合并：${job.keeperCode} ← ${job.absorbedCode}` : '合并探方（重新布方后认定为同一探方）'"
    width="820px"
    :close-on-click-modal="false"
  >
    <el-steps :active="step" align-center class="steps">
      <el-step title="选定保留方" description="两边记录并到这一方" />
      <el-step title="核对合并方案" description="改号 / 曾用号 / 跨方关系" />
      <el-step title="完成" description="可继续裁定跨方关系" />
    </el-steps>

    <!-- 第一步：选择两个探方 -->
    <div v-if="step === 0" class="step-body">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="alert"
        title="合并规则"
        description="地层单位号撞了的，按保留方重排，被改号的原编号留作曾用号；器物编号不动（实物标签不重写）；跨方关系先隔离待整理员裁定，不会硬写进关系图。"
      />
      <el-form label-width="110px">
        <el-form-item label="保留方（主号）" required>
          <el-select v-model="form.keeperTrenchId" filterable placeholder="编号以这一方为准，如 T0501" style="width: 100%">
            <el-option
              v-for="trench in trenchState.trenches"
              :key="trench.id"
              :label="`${trench.area} · ${trench.code}`"
              :value="trench.id"
              :disabled="trench.id === form.absorbedTrenchId"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="被并入方" required>
          <el-select v-model="form.absorbedTrenchId" filterable placeholder="这一方将并入保留方并删除，如 T0502" style="width: 100%">
            <el-option
              v-for="trench in trenchState.trenches"
              :key="trench.id"
              :label="`${trench.area} · ${trench.code}`"
              :value="trench.id"
              :disabled="trench.id === form.keeperTrenchId"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <div v-if="keeperTrench && absorbedTrench" class="compare">
        <el-card shadow="never" class="compare-card keeper">
          <template #header>保留方 {{ keeperTrench.code }}（合并后保留）</template>
          <p>地层单位 {{ unitsOf(keeperTrench.id).length }} 个 · 出土物 {{ artifactsCountOf(keeperTrench.id) }} 件</p>
          <p class="muted">单位号保持不变</p>
        </el-card>
        <el-card shadow="never" class="compare-card absorbed">
          <template #header>被并方 {{ absorbedTrench.code }}（合并后删除）</template>
          <p>地层单位 {{ unitsOf(absorbedTrench.id).length }} 个 · 出土物 {{ artifactsCountOf(absorbedTrench.id) }} 件</p>
          <p class="muted">单位整体迁入；撞号单位重排，原号留作曾用号</p>
        </el-card>
      </div>
    </div>

    <!-- 第二步：方案预览 -->
    <div v-else-if="step === 1 && plan && activeJob" class="step-body">
      <el-alert
        v-if="executeError"
        type="error"
        :closable="false"
        show-icon
        class="alert"
        :title="`上次执行失败（两个探方均未改动）：${executeError}`"
        description="已按事务整体回滚，两个探方仍是合并前的样子。若提示数据有变动，请放弃草稿后重新制定方案；否则可直接重试。"
      />
      <el-descriptions :column="3" border size="small" class="summary">
        <el-descriptions-item label="保留方">{{ activeJob.keeperCode }}（编号不动）</el-descriptions-item>
        <el-descriptions-item label="被并方">{{ activeJob.absorbedCode }}（整体并入后删除）</el-descriptions-item>
        <el-descriptions-item label="被并方单位">{{ plan.absorbedUnitCount }} 个</el-descriptions-item>
        <el-descriptions-item label="撞号重排">{{ plan.renamedCount }} 个（原号登记为曾用号）</el-descriptions-item>
        <el-descriptions-item label="跨方关系隔离">{{ plan.spanningCount }} 条（交整理员裁定）</el-descriptions-item>
        <el-descriptions-item label="器物编号">一律不改，靠所属单位自动跟随</el-descriptions-item>
      </el-descriptions>

      <el-table :data="plan.remaps" border size="small" class="plan-table">
        <template #empty>无撞号单位，被并方单位号均可直接沿用</template>
        <el-table-column label="原所属探方" width="110">
          <template #default>{{ activeJob.absorbedCode }}</template>
        </el-table-column>
        <el-table-column prop="oldCode" label="原单位号" width="110" />
        <el-table-column label="重排后" width="120">
          <template #default="{ row }">
            <el-tag type="warning" size="small" effect="dark">{{ row.newCode }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="曾用号（登记到单位上）" min-width="180">
          <template #default="{ row }">
            <span class="mono">{{ row.formerCode }}</span>
          </template>
        </el-table-column>
      </el-table>

      <el-divider content-position="left">跨方关系（{{ plan.plannedReviews.length }} 条，全部隔离待裁定，不写入关系图）</el-divider>
      <ul class="review-preview">
        <li v-for="review in plan.plannedReviews" :key="review.id">
          <span class="mono">{{ unitText(review.unitAId) }}</span>
          <el-tag size="small" effect="dark" class="rel-type">{{ review.type }}</el-tag>
          <span class="mono">{{ unitText(review.unitBId) }}</span>
          <el-tag
            v-for="kind in review.warnings"
            :key="kind"
            size="small"
            :type="warningType[kind].type"
            effect="plain"
            class="warn-tag"
          >
            {{ warningType[kind].label }}
          </el-tag>
          <span v-if="review.warnings.length === 0" class="muted">无明显风险</span>
        </li>
        <li v-if="plan.plannedReviews.length === 0" class="muted">两个探方之间没有跨方关系</li>
      </ul>
      <el-alert
        v-if="plan.plannedReviews.some((item) => item.warnings.length > 0)"
        type="warning"
        :closable="false"
        show-icon
        class="alert"
        title="存在可能绕成圈或与深度对不上的跨方关系，已全部留到「层位关系」页由整理员逐条定夺，本次合并不会写入它们"
      />
    </div>

    <!-- 第三步：完成 -->
    <div v-else-if="step === 2 && activeJob" class="step-body done">
      <el-result icon="success" title="合并完成" :sub-title="`${activeJob.absorbedCode} 的记录已并入 ${activeJob.keeperCode}，器物编号未做任何改动`">
        <template #extra>
          <p v-if="activeJob.plannedReviews.length > 0" class="muted">
            有 {{ activeJob.plannedReviews.length }} 条跨方关系等待裁定，请前往「层位关系」页处理（采纳 / 放弃）。
          </p>
          <el-button type="primary" @click="goRelations">去裁定跨方关系</el-button>
          <el-button @click="dialogVisible = false">稍后处理</el-button>
        </template>
      </el-result>
    </div>

    <template #footer>
      <template v-if="step === 0">
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!canGenerate()" :loading="submitting" @click="generatePlan">
          生成合并方案
        </el-button>
      </template>
      <template v-else-if="step === 1">
        <el-button type="danger" plain :disabled="executing" @click="abandonDraft">废弃草稿</el-button>
        <el-button @click="dialogVisible = false" :disabled="executing">先关掉（草稿保留，可继续）</el-button>
        <el-button type="primary" :loading="executing" @click="runMerge">
          {{ executeError ? '重试合并' : '执行合并（事务提交，失败整体回滚）' }}
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<style scoped>
.steps {
  margin: 6px 0 18px;
}
.step-body {
  min-height: 240px;
}
.alert {
  margin-bottom: 14px;
}
.compare {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}
.compare-card {
  flex: 1;
  border-radius: 10px;
}
.compare-card.keeper {
  border-color: #2f6f8f;
}
.compare-card.absorbed {
  border-color: #c9a227;
}
.compare-card p {
  margin: 4px 0;
  font-size: 13px;
}
.summary {
  margin-bottom: 12px;
}
.plan-table {
  margin-bottom: 8px;
}
.review-preview {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
}
.review-preview li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  border-bottom: 1px dotted #e6ded0;
  font-size: 12px;
}
.rel-type {
  margin: 0 2px;
}
.warn-tag {
  margin-left: 2px;
}
.done {
  display: flex;
  justify-content: center;
}
.muted {
  color: #8a8073;
  font-size: 12px;
}
</style>
