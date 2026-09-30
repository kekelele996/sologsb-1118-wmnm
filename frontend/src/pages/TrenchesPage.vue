<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Trench } from '@/types'
import { TRENCH_SIZES, findTrenchConflict, trenchKey } from '@/types'
import TrenchTag from '@/components/common/TrenchTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { trenchStore } from '@/stores/trenchStore'
import { stratumStore } from '@/stores/stratumStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import { uid } from '@/utils/id'
import { buildMergePlan, executeMerge, type MergePlan } from '@/utils/merge'

const trenchState = useStore(trenchStore)
const stratumState = useStore(stratumStore)
const artifactState = useStore(artifactStore)
const relationState = useStore(relationStore)

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const filterArea = ref('')

const mergeDialogVisible = ref(false)
const mergeRetainedId = ref('')
const mergeAwayId = ref('')
const merging = ref(false)

const form = reactive({
  code: '',
  area: '',
  size: '5×5 米' as Trench['size'],
  basePoint: '',
  openLayer: '第①层',
  startDate: new Date().toISOString().slice(0, 10),
  endDate: '',
  leader: '',
  wallNote: '',
  backfilled: false
})

const areas = computed(() => Array.from(new Set(trenchState.trenches.map((item) => item.area))))
const visible = computed(() =>
  filterArea.value ? trenchState.trenches.filter((item) => item.area === filterArea.value) : trenchState.trenches
)

watch(
  () => trenchState.trenches.length,
  () => {
    if (!form.area && trenchState.trenches.length > 0) {
      form.area = trenchState.trenches[0].area
    }
  },
  { immediate: true }
)

/** 单位数与出土物件数 */
function unitsOf(trenchId: string): number {
  return stratumState.strata.filter((item) => item.trenchId === trenchId).length
}

function artifactsOf(trenchId: string): number {
  const unitIds = stratumState.strata.filter((item) => item.trenchId === trenchId).map((item) => item.id)
  return artifactState.artifacts.filter((item) => unitIds.includes(item.stratumId)).reduce((sum, item) => sum + item.count, 0)
}

function relationsOf(trenchId: string): number {
  const unitIds = stratumState.strata.filter((item) => item.trenchId === trenchId).map((item) => item.id)
  return relationState.relations.filter((item) => unitIds.includes(item.unitAId) || unitIds.includes(item.unitBId)).length
}

/** 发掘进度状态 */
function progressOf(trench: Trench): { label: string; type: 'success' | 'warning' | 'info' } {
  if (trench.backfilled) return { label: '已回填', type: 'info' }
  if (unitsOf(trench.id) === 0) return { label: '待发掘', type: 'warning' }
  if (trench.endDate) return { label: '发掘完成', type: 'success' }
  return { label: '发掘中', type: 'success' }
}

/** 层位关系预览用：单位号（探方 · 类型） */
function unitLabel(stratumId: string): string {
  const stratum = stratumState.strata.find((item) => item.id === stratumId)
  if (!stratum) return '未知单位'
  const trench = trenchState.trenches.find((item) => item.id === stratum.trenchId)
  return `${stratum.code}（${trench ? `${trench.code} ` : ''}${stratum.type}）`
}

function resetForm(): void {
  editingId.value = null
  form.code = ''
  form.area = trenchState.trenches[0]?.area ?? ''
  form.size = '5×5 米'
  form.basePoint = ''
  form.openLayer = '第①层'
  form.startDate = new Date().toISOString().slice(0, 10)
  form.endDate = ''
  form.leader = ''
  form.wallNote = ''
  form.backfilled = false
}

function openCreate(): void {
  resetForm()
  dialogVisible.value = true
}

function openEdit(trench: Trench): void {
  editingId.value = trench.id
  Object.assign(form, {
    code: trench.code,
    area: trench.area,
    size: trench.size,
    basePoint: trench.basePoint,
    openLayer: trench.openLayer,
    startDate: trench.startDate,
    endDate: trench.endDate,
    leader: trench.leader,
    wallNote: trench.wallNote,
    backfilled: trench.backfilled
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  if (!form.code.trim() || !form.area.trim()) {
    ElMessage.warning('探方号与发掘区必填')
    return
  }
  const candidate = { id: editingId.value ?? uid('tr'), area: form.area.trim(), code: form.code.trim().toUpperCase() }
  const conflict = findTrenchConflict(trenchState.trenches, candidate)
  if (conflict) {
    ElMessage.error(`「${trenchKey(candidate)}」已存在（同发掘区探方号必须唯一）`)
    return
  }
  const row: Trench = {
    id: candidate.id,
    code: candidate.code,
    area: candidate.area,
    size: form.size,
    basePoint: form.basePoint.trim(),
    openLayer: form.openLayer.trim(),
    startDate: form.startDate,
    endDate: form.endDate,
    leader: form.leader.trim(),
    wallNote: form.wallNote.trim(),
    backfilled: form.backfilled
  }
  await trenchStore.getState().save(row)
  ElMessage.success(`探方 ${trenchKey(row)} 已保存`)
  dialogVisible.value = false
}

async function remove(trench: Trench): Promise<void> {
  const units = unitsOf(trench.id)
  if (units > 0) {
    ElMessage.error(`${trenchKey(trench)} 下仍有 ${units} 个地层单位，请先清理下级记录`)
    return
  }
  await ElMessageBox.confirm(`确认删除探方「${trenchKey(trench)}」？`, '删除确认', { type: 'warning' })
  await trenchStore.getState().remove(trench.id)
  ElMessage.success('探方已删除')
}

/** 合并方案预览：保留方 / 被并方选定后实时计算 */
const mergePlan = computed<MergePlan | null>(() => {
  if (!mergeRetainedId.value || !mergeAwayId.value || mergeRetainedId.value === mergeAwayId.value) return null
  const retained = trenchState.trenches.find((item) => item.id === mergeRetainedId.value)
  const away = trenchState.trenches.find((item) => item.id === mergeAwayId.value)
  if (!retained || !away) return null
  return buildMergePlan(retained, away, stratumState.strata, relationState.relations)
})

/** 被并方随单位改属的出土物件数（器物编号不重写） */
const mergeAwayArtifactCount = computed(() => {
  if (!mergePlan.value) return 0
  const awayIds = new Set(
    stratumState.strata.filter((item) => item.trenchId === mergePlan.value!.mergedAway.id).map((item) => item.id)
  )
  return artifactState.artifacts.filter((item) => awayIds.has(item.stratumId)).length
})

function openMerge(): void {
  mergeRetainedId.value = trenchState.trenches[0]?.id ?? ''
  mergeAwayId.value = trenchState.trenches[1]?.id ?? ''
  mergeDialogVisible.value = true
}

async function hydrateAll(): Promise<void> {
  await Promise.all([
    trenchStore.getState().hydrate(),
    stratumStore.getState().hydrate(),
    artifactStore.getState().hydrate(),
    relationStore.getState().hydrate()
  ])
}

async function runMerge(): Promise<void> {
  const plan = mergePlan.value
  if (!plan) return
  if (plan.retained.area !== plan.mergedAway.area) {
    try {
      await ElMessageBox.confirm(
        `两个探方不在同一发掘区（${plan.retained.area} / ${plan.mergedAway.area}），请确认确为同一探方后再合并。是否继续？`,
        '跨发掘区合并确认',
        { type: 'warning' }
      )
    } catch {
      return
    }
  }
  merging.value = true
  try {
    const result = await executeMerge(plan)
    await hydrateAll()
    ElMessage.success(
      `已把 ${result.mergedAway.code} 并入 ${result.retained.code}：重排单位号 ${result.renumbered.length} 个，` +
        `直接合入跨方关系 ${result.keptCount} 条，${result.pendingCount} 条待整理员定夺`
    )
    mergeDialogVisible.value = false
  } catch (error) {
    // 事务已回滚，再全量同步一次内存，确保界面与恢复后的库一致
    await hydrateAll()
    ElMessage.error(
      `合并失败，两个探方已恢复成合并前的样子，可重新打开再并。${error instanceof Error ? `（${error.message}）` : ''}`
    )
  } finally {
    merging.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">探方清单</h2>
        <p class="page-sub">
          按「发掘区-探方号」校验唯一性；卡片展示地层单位数、出土物件数、层位关系数与发掘进度状态。
        </p>
      </div>
      <el-button type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>新建探方
      </el-button>
      <el-button @click="openMerge">
        <el-icon><Link /></el-icon>合并探方
      </el-button>
    </div>

    <div class="toolbar">
      <el-select v-model="filterArea" placeholder="全部发掘区" clearable style="width: 180px">
        <el-option v-for="area in areas" :key="area" :label="area" :value="area" />
      </el-select>
      <el-tag effect="plain">命中 {{ visible.length }} / {{ trenchState.trenches.length }} 个探方</el-tag>
    </div>

    <div class="card-grid">
      <el-card v-for="trench in visible" :key="trench.id" shadow="hover" class="trench-card">
        <div class="card-top">
          <TrenchTag :trench="trench" />
          <el-tag :type="progressOf(trench).type" size="small" effect="plain">{{ progressOf(trench).label }}</el-tag>
        </div>
        <div class="metrics">
          <div class="metric"><span>地层单位</span><b>{{ unitsOf(trench.id) }}</b></div>
          <div class="metric"><span>出土物件数</span><b>{{ artifactsOf(trench.id) }}</b></div>
          <div class="metric"><span>层位关系</span><b>{{ relationsOf(trench.id) }}</b></div>
          <div class="metric"><span>规格</span><b>{{ trench.size }}</b></div>
        </div>
        <el-descriptions :column="1" size="small" border class="desc">
          <el-descriptions-item label="基点坐标">{{ trench.basePoint || '—' }}</el-descriptions-item>
          <el-descriptions-item label="开口层位">{{ trench.openLayer || '—' }}</el-descriptions-item>
          <el-descriptions-item label="发掘日期">
            {{ trench.startDate }} ~ {{ trench.endDate || '进行中' }}
          </el-descriptions-item>
          <el-descriptions-item label="负责人">{{ trench.leader || '—' }}</el-descriptions-item>
          <el-descriptions-item label="四壁方向备注">{{ trench.wallNote || '—' }}</el-descriptions-item>
        </el-descriptions>
        <div class="card-actions">
          <el-button size="small" @click="openEdit(trench)">编辑</el-button>
          <el-button size="small" @click="trenchStore.getState().setBackfilled(trench.id, !trench.backfilled)">
            {{ trench.backfilled ? '取消回填标记' : '标记已回填' }}
          </el-button>
          <el-button size="small" type="danger" plain @click="remove(trench)">删除</el-button>
        </div>
      </el-card>
      <el-empty v-if="visible.length === 0" description="暂无探方，先新建一个探方" />
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑探方' : '新建探方'" width="640px">
      <el-form label-width="110px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="发掘区" required>
              <el-input v-model="form.area" placeholder="如 Ⅱ区" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="探方号" required>
              <el-input v-model="form.code" placeholder="如 T0501" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="规格">
              <el-select v-model="form.size" style="width: 100%">
                <el-option v-for="item in TRENCH_SIZES" :key="item" :label="item" :value="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="基点坐标">
              <el-input v-model="form.basePoint" placeholder="如 N1200 / E3000" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="开口层位">
              <el-input v-model="form.openLayer" placeholder="如 第①层" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="负责人">
              <el-input v-model="form.leader" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="发掘起始">
              <el-date-picker v-model="form.startDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="发掘结束">
              <el-date-picker v-model="form.endDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="四壁备注">
          <el-input v-model="form.wallNote" type="textarea" :rows="2" placeholder="如 北壁、东壁保存较好；南壁被现代扰坑破坏" />
        </el-form-item>
        <el-form-item label="是否已回填">
          <el-switch v-model="form.backfilled" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="mergeDialogVisible" title="合并探方（重新布方后认定为同一探方）" width="760px">
      <el-alert
        class="merge-alert"
        type="info"
        :closable="false"
        show-icon
        title="合并把被并方的地层单位、出土物、层位关系并入保留方，被并方记录随后删除。单位号撞号的按保留方序号重排、原号留作曾用号；器物编号已贴在实物上，不随合并改写；跨方关系合入后若会绕圈或与深度对不上，挂起交整理员定夺，不硬写入。合并在一个事务内完成，失败即回滚，两个探方恢复成合并前的样子。"
      />
      <el-form label-width="90px" class="merge-form">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="保留方" required>
              <el-select v-model="mergeRetainedId" style="width: 100%">
                <el-option
                  v-for="trench in trenchState.trenches"
                  :key="trench.id"
                  :label="`${trench.area} · ${trench.code}`"
                  :value="trench.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="被并方" required>
              <el-select v-model="mergeAwayId" style="width: 100%">
                <el-option
                  v-for="trench in trenchState.trenches"
                  :key="trench.id"
                  :label="`${trench.area} · ${trench.code}`"
                  :value="trench.id"
                />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <p v-if="mergeRetainedId && mergeAwayId && mergeRetainedId === mergeAwayId" class="warn">
          保留方与被并方不能是同一个探方
        </p>
      </el-form>

      <div v-if="mergePlan" class="merge-preview">
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="保留方">{{ mergePlan.retained.area }} · {{ mergePlan.retained.code }}</el-descriptions-item>
          <el-descriptions-item label="被并方">{{ mergePlan.mergedAway.area }} · {{ mergePlan.mergedAway.code }}</el-descriptions-item>
          <el-descriptions-item label="重排单位号">
            <b>{{ mergePlan.renumbers.length }}</b> 个（原号留作曾用号）
          </el-descriptions-item>
          <el-descriptions-item label="随单位改属出土物">
            <b>{{ mergeAwayArtifactCount }}</b> 件（器物编号不重写）
          </el-descriptions-item>
          <el-descriptions-item label="直接合入跨方关系">
            <b>{{ mergePlan.keptRelations.length }}</b> 条
          </el-descriptions-item>
          <el-descriptions-item label="待整理员定夺">
            <b class="pending-num">{{ mergePlan.pendingRelations.length }}</b> 条
          </el-descriptions-item>
        </el-descriptions>

        <template v-if="mergePlan.renumbers.length > 0">
          <h4 class="preview-title">单位号撞号重排（按保留方序号重排，原号留作曾用号）</h4>
          <el-table :data="mergePlan.renumbers" border size="small" max-height="220">
            <el-table-column label="被并方原单位号" width="160">
              <template #default="{ row }: { row: { from: string } }">
                <span class="mono">{{ row.from }}</span>
              </template>
            </el-table-column>
            <el-table-column label="重排后单位号" width="160">
              <template #default="{ row }: { row: { to: string } }">
                <span class="mono">{{ row.to }}</span>
              </template>
            </el-table-column>
            <el-table-column label="说明">
              <template #default="{ row }: { row: { from: string; to: string } }">
                <span class="muted">
                  改属保留方 {{ mergePlan.retained.code }}，原号「{{ row.from }}」留作曾用号
                </span>
              </template>
            </el-table-column>
          </el-table>
        </template>

        <template v-if="mergePlan.keptRelations.length > 0">
          <h4 class="preview-title">直接合入的跨方关系（{{ mergePlan.keptRelations.length }} 条）</h4>
          <ul class="preview-list">
            <li v-for="relation in mergePlan.keptRelations" :key="relation.id">
              <span class="mono">{{ unitLabel(relation.unitAId) }}</span>
              <el-tag size="small" effect="dark" class="type">{{ relation.type }}</el-tag>
              <span class="mono">{{ unitLabel(relation.unitBId) }}</span>
            </li>
          </ul>
        </template>

        <template v-if="mergePlan.pendingRelations.length > 0">
          <h4 class="preview-title pending-title">待整理员定夺（{{ mergePlan.pendingRelations.length }} 条，不硬写入）</h4>
          <ul class="preview-list">
            <li v-for="relation in mergePlan.pendingRelations" :key="relation.id" class="pending-item">
              <div>
                <span class="mono">{{ unitLabel(relation.unitAId) }}</span>
                <el-tag size="small" type="warning" effect="dark" class="type">{{ relation.type }}</el-tag>
                <span class="mono">{{ unitLabel(relation.unitBId) }}</span>
              </div>
              <p class="pending-reason">{{ relation.pendingReason }}</p>
            </li>
          </ul>
        </template>
      </div>

      <template #footer>
        <el-button @click="mergeDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="merging"
          :disabled="!mergePlan || mergePlan.retained.id === mergePlan.mergedAway.id"
          @click="runMerge"
        >
          确认合并
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.trench-card {
  border-radius: 12px;
}
.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-bottom: 12px;
}
.metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f7f4ee;
  font-size: 12px;
  color: #7d7264;
}
.metric b {
  font-size: 14px;
  color: #3c2f1f;
}
.desc {
  margin-bottom: 12px;
}
.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.merge-alert {
  margin-bottom: 14px;
}
.merge-form {
  margin-bottom: 12px;
}
.merge-preview {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.preview-title {
  margin: 0;
  font-size: 14px;
  color: #3c2f1f;
}
.pending-title {
  color: #b88230;
}
.preview-list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
}
.preview-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}
.pending-item {
  flex-direction: column;
  align-items: flex-start !important;
  gap: 2px !important;
}
.pending-reason {
  margin: 0;
  font-size: 12px;
  color: #b88230;
}
.pending-num {
  color: #b88230;
}
.type {
  margin: 0 2px;
}
.warn {
  margin: 0;
  color: #c0392b;
  font-size: 12px;
}
</style>
