<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Relation, RelationBasis, RelationType } from '@/types'
import { RELATION_BASES, RELATION_TYPES } from '@/types'
import RelationGraph from '@/components/common/RelationGraph.vue'
import UnitPicker from '@/components/common/UnitPicker.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { checkRelationCycle, useRelationGraph } from '@/hooks/useRelationGraph'
import { relationStore } from '@/stores/relationStore'
import { stratumStore } from '@/stores/stratumStore'
import { trenchStore } from '@/stores/trenchStore'
import { mergeStore } from '@/stores/mergeStore'
import { reviewDepthNote } from '@/utils/mergePlan'
import { uid } from '@/utils/id'

const relationState = useStore(relationStore)
const stratumState = useStore(stratumStore)
const trenchState = useStore(trenchStore)
const mergeState = useStore(mergeStore)

const filterTrenchId = ref('')
const activeId = ref<string | null>(null)
const editingId = ref<string | null>(null)

const form = reactive({
  unitAId: '',
  type: '叠压' as RelationType,
  unitBId: '',
  basis: '剖面观察' as RelationBasis,
  recorder: '',
  note: ''
})

const graphStrata = computed(() =>
  filterTrenchId.value
    ? stratumState.strata.filter((item) => item.trenchId === filterTrenchId.value)
    : stratumState.strata
)

const { graph, highlighted, degreeOf } = useRelationGraph(
  graphStrata,
  computed(() => relationState.relations),
  activeId
)

const activeNode = computed(() => graph.value.nodes.find((node) => node.id === activeId.value) ?? null)
const directOut = computed(() => (activeId.value ? graph.value.adjacency.get(activeId.value) ?? [] : []))
const directIn = computed(() => (activeId.value ? graph.value.reverse.get(activeId.value) ?? [] : []))

watch(
  () => [graphStrata.value.length, form.unitAId, form.unitBId] as const,
  () => {
    const list = graphStrata.value
    if (list.length === 0) return
    if (!list.some((item) => item.id === form.unitAId)) form.unitAId = list[0].id
    if (!list.some((item) => item.id === form.unitBId)) form.unitBId = list[1]?.id ?? list[0].id
  },
  { immediate: true }
)

function unitLabel(stratumId: string): string {
  const stratum = stratumState.strata.find((item) => item.id === stratumId)
  if (!stratum) return '未知单位'
  const trench = trenchState.trenches.find((item) => item.id === stratum.trenchId)
  return `${stratum.code}（${trench ? `${trench.area}·${trench.code}` : '未知探方'} · ${stratum.type}）`
}

function resetForm(): void {
  editingId.value = null
  form.type = '叠压'
  form.basis = '剖面观察'
  form.recorder = ''
  form.note = ''
}

async function submit(): Promise<void> {
  if (!form.unitAId || !form.unitBId) {
    ElMessage.warning('请选择单位 A 与单位 B')
    return
  }
  if (form.unitAId === form.unitBId) {
    ElMessage.error('单位 A 与单位 B 不能相同')
    return
  }
  const others = relationState.relations.filter((item) => item.id !== editingId.value)
  if (checkRelationCycle(others, { unitAId: form.unitAId, unitBId: form.unitBId, type: form.type })) {
    ElMessage.error(
      `拒绝保存：${unitLabel(form.unitAId)} ${form.type} ${unitLabel(form.unitBId)} 会形成环路矛盾（层位关系不能自相闭合）`
    )
    return
  }
  const row: Relation = {
    id: editingId.value ?? uid('rl'),
    unitAId: form.unitAId,
    type: form.type,
    unitBId: form.unitBId,
    basis: form.basis,
    recorder: form.recorder.trim(),
    note: form.note.trim()
  }
  await relationStore.getState().save(row)
  ElMessage.success(`已记录：${unitLabel(row.unitAId)} ${row.type} ${unitLabel(row.unitBId)}`)
  resetForm()
}

function edit(relation: Relation): void {
  editingId.value = relation.id
  Object.assign(form, {
    unitAId: relation.unitAId,
    type: relation.type,
    unitBId: relation.unitBId,
    basis: relation.basis,
    recorder: relation.recorder,
    note: relation.note
  })
}

async function remove(relation: Relation): Promise<void> {
  await ElMessageBox.confirm(
    `确认删除关系「${unitLabel(relation.unitAId)} ${relation.type} ${unitLabel(relation.unitBId)}」？`,
    '删除确认',
    { type: 'warning' }
  )
  await relationStore.getState().remove(relation.id)
  ElMessage.success('关系已删除')
}

function selectNode(nodeId: string): void {
  activeId.value = activeId.value === nodeId ? null : nodeId
}

/** 探方合并隔离出来的跨方关系，等整理员裁定（不计入关系图） */
const pendingReviews = computed(() => mergeState.reviews.filter((item) => item.status === 'pending'))

function reviewJobLabel(mergeJobId: string): string {
  const job = mergeState.mergeJobs.find((item) => item.id === mergeJobId)
  return job ? `${job.keeperCode} ← ${job.absorbedCode}` : '已删除的合并任务'
}

const warningMeta: Record<string, { label: string; type: 'danger' | 'warning' | 'info' }> = {
  cycle: { label: '可能绕成环路', type: 'danger' },
  depthConflict: { label: '与深度对不上', type: 'warning' },
  duplicate: { label: '与已有关系重复', type: 'info' }
}

async function accept(reviewId: string): Promise<void> {
  const review = pendingReviews.value.find((item) => item.id === reviewId)
  if (!review) return
  const depthNote = reviewDepthNote(review, stratumState.strata)
  if (depthNote) {
    try {
      await ElMessageBox.confirm(
        `${depthNote}。跨方关系由整理员最终定夺，仍要采纳写入关系图吗？`,
        '深度矛盾确认',
        { type: 'warning', confirmButtonText: '仍要采纳', cancelButtonText: '再想想' }
      )
    } catch {
      return
    }
  }
  const result = await mergeStore.getState().acceptReview(reviewId)
  if (!result.ok) {
    ElMessage.error(`无法采纳：${result.reason}`)
    return
  }
  ElMessage.success('跨方关系已采纳并写入关系图')
}

async function discard(reviewId: string): Promise<void> {
  await ElMessageBox.confirm('放弃后该跨方关系不会写入关系图（记录保留处置痕迹），确认放弃？', '放弃跨方关系', {
    type: 'warning'
  })
  await mergeStore.getState().discardReview(reviewId)
  ElMessage.success('已放弃该跨方关系')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">层位关系视图</h2>
        <p class="page-sub">
          以有向图展示叠压与打破关系；点击节点高亮其直接关系（前后继），新增关系时先做环路检测，闭合矛盾关系会被拒绝保存。
        </p>
      </div>
      <el-select v-model="filterTrenchId" placeholder="全部探方" clearable style="width: 190px">
        <el-option v-for="trench in trenchState.trenches" :key="trench.id" :label="`${trench.area} · ${trench.code}`" :value="trench.id" />
      </el-select>
    </div>

    <el-alert
      v-if="graph.hasCycle"
      class="alert"
      type="error"
      :closable="false"
      show-icon
      :title="`检测到环路关系（矛盾）：${graph.cyclePath.map((id) => stratumState.strata.find((item) => item.id === id)?.code ?? id).join(' → ')} → ${stratumState.strata.find((item) => item.id === graph.cyclePath[0])?.code ?? ''}`"
    />
    <el-alert
      v-else
      class="alert"
      type="success"
      :closable="false"
      show-icon
      title="当前层位关系无环路矛盾"
    />

    <el-card v-if="pendingReviews.length > 0" shadow="never" class="review-card">
      <template #header>
        <div class="review-head">
          <span>跨方关系待裁定（{{ pendingReviews.length }}）</span>
          <span class="muted">
            来自探方合并，系统未写入关系图；可能绕成圈或与深度对不上的已标出，由整理员逐条采纳或放弃
          </span>
        </div>
      </template>
      <el-table :data="pendingReviews" border size="small">
        <el-table-column label="合并来源" width="150">
          <template #default="{ row }">{{ reviewJobLabel(row.mergeJobId) }}</template>
        </el-table-column>
        <el-table-column label="单位 A" min-width="150">
          <template #default="{ row }"><span class="mono">{{ unitLabel(row.unitAId) }}</span></template>
        </el-table-column>
        <el-table-column label="关系" width="80">
          <template #default="{ row }">
            <el-tag size="small" effect="dark">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="单位 B" min-width="150">
          <template #default="{ row }"><span class="mono">{{ unitLabel(row.unitBId) }}</span></template>
        </el-table-column>
        <el-table-column label="风险预判" width="220">
          <template #default="{ row }">
            <el-tag
              v-for="kind in row.warnings"
              :key="kind"
              size="small"
              :type="warningMeta[kind].type"
              effect="plain"
              class="warn-tag"
            >
              {{ warningMeta[kind].label }}
            </el-tag>
            <span v-if="row.warnings.length === 0" class="muted">无明显风险</span>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="原始备注" min-width="160" show-overflow-tooltip />
        <el-table-column label="处置" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="accept(row.id)">采纳</el-button>
            <el-button link type="danger" size="small" @click="discard(row.id)">放弃</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <div class="layout">
      <el-card shadow="never" class="graph-card">
        <template #header>
          <div class="card-head">
            <span>层位关系有向图（{{ graph.nodes.length }} 节点 / {{ graph.edges.length }} 条边）</span>
            <span class="muted">
              <template v-if="activeNode">
                已选中 {{ activeNode.label }}：直接后继 {{ directOut.length }} 个、直接前驱 {{ directIn.length }} 个、关联度
                {{ degreeOf(activeNode.id) }}
              </template>
              <template v-else>点击节点查看直接关系</template>
            </span>
          </div>
        </template>
        <RelationGraph
          :nodes="graph.nodes"
          :edges="graph.edges"
          :highlighted="highlighted"
          :active-id="activeId"
          :width="720"
          :height="420"
          @select="selectNode"
        />
      </el-card>

      <div class="side">
        <el-card shadow="never" class="form-card">
          <template #header>{{ editingId ? '编辑层位关系' : '新增层位关系' }}</template>
          <UnitPicker
            :trenches="trenchState.trenches"
            :strata="stratumState.strata"
            :trench-id="filterTrenchId"
            :model-value="form.unitAId"
            :show-depth-range="false"
            @update:model-value="(value: string) => (form.unitAId = value)"
          />
          <el-form label-width="76px" size="small" class="rel-form">
            <el-form-item label="关系类型">
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="item in RELATION_TYPES" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
            <el-form-item label="单位 B">
              <el-select v-model="form.unitBId" filterable style="width: 100%">
                <el-option
                  v-for="item in graphStrata"
                  :key="item.id"
                  :label="`${item.code}（${item.type} · ${item.topDepth}–${item.bottomDepth} m）`"
                  :value="item.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="判定依据">
              <el-select v-model="form.basis" style="width: 100%">
                <el-option v-for="item in RELATION_BASES" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
            <el-form-item label="记录人">
              <el-input v-model="form.recorder" />
            </el-form-item>
            <el-form-item label="备注">
              <el-input v-model="form.note" type="textarea" :rows="2" placeholder="如 H12 开口于第②层下，打破 L02" />
            </el-form-item>
            <div class="actions">
              <el-button type="primary" size="small" @click="submit">保存关系</el-button>
              <el-button v-if="editingId" size="small" @click="resetForm">取消</el-button>
            </div>
          </el-form>
        </el-card>

        <el-card shadow="never" class="list-card">
          <template #header>关系清单（{{ relationState.relations.length }}）</template>
          <ul class="rel-list">
            <li v-for="relation in relationState.relations" :key="relation.id">
              <span class="mono">{{ unitLabel(relation.unitAId) }}</span>
              <el-tag size="small" effect="dark" class="type">{{ relation.type }}</el-tag>
              <span class="mono">{{ unitLabel(relation.unitBId) }}</span>
              <span class="muted">（{{ relation.basis }} · {{ relation.recorder || '未填记录人' }}）</span>
              <span class="ops">
                <el-button link type="primary" size="small" @click="edit(relation)">编辑</el-button>
                <el-button link type="danger" size="small" @click="remove(relation)">删除</el-button>
              </span>
            </li>
            <li v-if="relationState.relations.length === 0" class="muted">暂无层位关系</li>
          </ul>
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.alert {
  margin-bottom: 14px;
}
.review-card {
  margin-bottom: 16px;
  border-radius: 12px;
}
.review-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.warn-tag {
  margin-right: 4px;
}
.layout {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}
.graph-card {
  flex: 1 1 560px;
  border-radius: 12px;
}
.side {
  flex: 1 1 320px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.form-card,
.list-card {
  border-radius: 12px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.rel-form {
  margin-top: 10px;
}
.actions {
  display: flex;
  gap: 8px;
  padding-left: 76px;
}
.rel-list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.rel-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  border-bottom: 1px dotted #e6ded0;
}
.type {
  margin: 0 2px;
}
.ops {
  margin-left: auto;
}
</style>
