# 考古探方地层编目台（gbtrenchlog）

面向考古发掘工地的记录员与整理人员，把「探方 → 地层单位 → 堆积描述 → 层位关系 → 出土物」整理成一套可核对的编目档案，解决地层编号重复、打破与叠压关系记不清、出土物脱离层位上下文的问题。**纯前端单页应用**，全部数据保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21818>

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地）
```

`.env` 可调：

```
COMPOSE_PROJECT_NAME=gbtrenchlog
FRONTEND_PORT=21818
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（Composition API） |
| 语言 | TypeScript（`vue-tsc` 类型检查零错误） |
| UI 组件库 | Element Plus |
| 状态管理 | Zustand（`zustand/vanilla` createStore + Vue 响应式桥接） |
| 路由 | Vue Router 4（History 模式，nginx `try_files` 回落） |
| 构建 | Vite 6 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21818
npm run build      # 类型检查 + 生产构建
```

## 四、目录结构

```
sologsb-1118/
├── docker-compose.yml          # 顶层 name: gbtrenchlog，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # trench / stratum / artifact / relation / merge / index
│       ├── stores/             # trench / stratum / artifact / relation / merge（Zustand）
│       ├── components/common/  # StratumDepthBar / RelationGraph / TrenchTag / UnitPicker
│       ├── components/merge/   # MergeTrenchesDialog（合并向导：选择→预览→执行）
│       ├── hooks/              # useStratumOrder / useRelationGraph / usePersistentStore
│       ├── pages/              # TrenchesPage / StrataPage / ArtifactsPage / RelationsPage / SectionsPage
│       ├── services/           # mergeService（事务执行 / 断点续并 / 待裁定处置）
│       ├── router/index.ts
│       └── utils/              # graph.ts / mergePlan.ts / export.ts / id.ts
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| Trench 探方 | 探方号、发掘区、规格、基点坐标、开口层位、发掘起止、负责人、四壁备注、是否回填、`mergedFromCodes` 合并来源 | `trenches` |
| Stratum 地层单位 | 单位号、类型（地层/灰坑/房址/沟/墓葬）、开口层位、上下界深度、土质土色、包含物、堆积成因、绘图拍照号、`formerCodes` 曾用号 | `strata` |
| Artifact 出土物 | 所属地层单位、器物编号、类别、件数、残整程度、探方内 X/Y/Z、出土日期、提取人、临时存放 | `artifacts` |
| Relation 层位关系 | 单位 A、关系类型（叠压/打破/共存）、单位 B、判定依据、记录人、备注 | `relations` |
| MergeJob 合并任务 | 保留方/被并方、改号方案、跨方关系待裁定方案、合并前快照、状态（draft/done）、失败原因 | `mergeJobs` |
| RelationReview 待裁定关系 | 合并隔离出的跨方关系、风险预判（环路/深度矛盾/重复）、处置状态（pending/accepted/discarded） | `relationReviews` |

- 数据库名 `gbtrenchlog`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史地层单位补齐「开口层位」字段并规范包含物数组；
- `version(3)` 支持探方合并：为历史地层单位补齐 `formerCodes`，新增 `mergeJobs`、`relationReviews` 两张表；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

### 探方合并（重新布方后两号同一方）

在「探方清单」页发起合并，例如认定 T0501、T0502 是同一个探方：

1. **保留方编号为准**：选择保留方（T0501）与被并方（T0502），先出方案预览再执行；
2. **撞号重排 + 曾用号**：地层单位号撞了的只改被并方（同字母前缀取最小空位，保持 L01/H12 补零风格），保留方单位号一律不动；被改号的原编号以「原探方号:原单位号」（如 `T0502:L01`）登记到该单位的 `formerCodes`，编目表、单位选择器、出土物清单都会展示；
3. **器物编号不动**：实物标签不重写，出土物仍按 `stratumId` 自动跟随迁入单位；出土物页支持按器物编号 / 现单位号 / 曾用号关键词检索，靠旧标签号也能找到那件东西；
4. **跨方关系交整理员定夺**：分属两个探方的层位关系不硬写进关系图，统一隔离到「层位关系」页的「跨方关系待裁定」区，并预判**环路**（绕成圈）、**深度矛盾**（与深度对不上）、**重复**三种风险；采纳时环路/重复会阻断，深度矛盾弹窗由整理员确认后仍可采纳，放弃则不写入；
5. **事务原子性**：合并在单个 IndexedDB 读写事务中完成，中途任一步失败整体回滚——两个探方都恢复成合并前的样子；草稿（含方案与合并前快照）保留，页面横幅可直接「继续合并」，重开也能接着再并；方案制定后数据有变动会检测到漂移并要求重新制定，不硬套旧方案。

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/trenches` | 探方清单：按「发掘区-探方号」校验唯一性，卡片显示单位数、出土物件数、关系数与发掘进度状态 |
| `/strata` | 地层单位编目表：按类型与深度区间筛选，层序倒置与单位号重复即时高亮，深度刻度条展示厚度 |
| `/artifacts` | 出土物登记与清单：先锁定所属地层单位（级联选择器），带出深度区间并校验出土深度是否在该区间内 |
| `/relations` | 层位关系视图：SVG 有向图展示叠压/打破，点击节点高亮直接关系，新增关系前做环路检测 |
| `/sections` | 四壁剖面示意：按深度刻度绘制地层条带与厚度标注，叠加出土物投影点 |

## 七、校验规则

- 同一「发掘区-探方号」只允许一个探方；
- 同一探方内单位号不可重复（保存时拒绝）；
- 上界深度大于下界深度即为**层序倒置**，编目表整行标红并在顶部汇总；
- 若「A 叠压/打破 B」但 A 的上界深度大于 B，则提示层位关系与深度矛盾；
- 新增层位关系前做**环路检测**（DFS），会形成闭合矛盾的关系直接拒绝保存；
- 出土物的 Z（深度）必须落在其所属地层单位的深度区间内，否则给出层位核对提示。
