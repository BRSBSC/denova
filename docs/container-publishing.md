# 上游 Release 同步与 GHCR 镜像

本 fork 的 `.github/workflows/sync-upstream-release.yml` 每小时第 23 分钟（UTC）检查 `alfredxw/denova` 最新正式 Release。GitHub 的定时任务可能延迟执行。只接受 `v主版本.次版本.补丁版本`，跳过预发布，不自动合并上游分支。

## 首次启用

1. 将本次改动推送到 `BRSBSC/denova` 的默认分支 `master`。
2. 在仓库 **Actions** 页面启用 fork 的工作流。若第一次推送没有触发，选择 **Sync upstream release and publish GHCR → Run workflow**。
3. 工作流使用内置 `GITHUB_TOKEN`，需要仓库允许 `contents: write` 和 `packages: write`，无需另存 PAT。若组织策略限制写权限，需要管理员放行；若同名 GHCR 包已存在，需在该包的 Actions access 中授权此仓库。
4. 首次发布后，在 **Packages → denova → Package settings** 中检查可见性。希望其他人无需登录即可拉取时，将包设置为 Public；公开仓库不代表包一定公开。
5. 查看本次 Actions 运行日志和 Summary，确认镜像发布与 Release 同步均成功。公开仓库长时间无活动可能被 GitHub 停用定时工作流，需要在 Actions 中重新启用。

镜像地址：`ghcr.io/brsbsc/denova:v0.4.5`（版本示例）以及 `ghcr.io/brsbsc/denova:latest`，支持 `linux/amd64`、`linux/arm64`。发布 job 仅允许在 `BRSBSC/denova` 执行；迁移到其他 fork 时须修改工作流仓库条件与 Compose 镜像地址。

## 发布与失败处理

- 下载上游 Release 的全部附件，校验 `checksums.txt` 覆盖的所有 Denova 安装包；Linux 两种架构缺失、校验失败或归档路径不安全时停止。
- 使用已发布的 Linux 安装包构建镜像，保留前端、Skills、updater 和许可证，不重新编译应用源码。容器额外安装 Bash、Git、curl、Python、ripgrep；其他语言工具链及外部 Agent CLI 需按需扩展镜像。
- 分别构建和测试两种架构：版本号、HTTP 页面、未登录访问拒绝、登录、设置读取，以及重启后的配置与登录会话保留。测试通过后推送版本镜像。
- fork Release 的标题保留上游版本号，tag 使用 `upstream-v版本号` 并指向本次工作流提交；镜像标签仍为 `v版本号`。这避免导入上游工作流所需的额外权限，也避免触发现有 `v*` 源码发布流程。Release 自动附带的 Source code 压缩包对应 fork 的构建配置，原始应用源码请查看说明中的上游链接。不会覆盖没有本流程来源标记的已有 Release。
- 仅当该版本仍是上游最新正式 Release，才将已测试版本镜像设为 `latest`。最后发布 Release 并写入完成标记；失败不会写入成功标记，后续定时任务可重试。首次失败可能留下 draft Release 或已推送的版本镜像。
- 镜像与 Release 属于不同服务，无法进行跨服务原子提交；若最终发布 Release 失败，`latest` 可能已经指向通过测试的镜像，重试会补齐 Release。
- 每次定时任务只处理当时最新正式 Release，不补齐所有历史版本。手动输入 `tag` 可补指定版本，勾选 `force` 可重建同一版本。修改容器或同步流程并推送 `master` 时，也会重建最新版本。
- 同步保留上游附件原样，包括安装脚本中的上游下载地址；只新增或替换同名附件，不自动删除此前已归档的附件。完成标记按 Release ID 和附件 ID、大小、更新时间计算，上游替换附件会触发重新处理。镜像仅使用当次下载并校验的 Linux 包。

这条流程不依赖 tag 触发另一个工作流：镜像构建、Release 同步在同一次运行内完成。

## 运行容器

在 `docker/.env` 中设置首次登录账号（此文件已被 Git 忽略）：

```dotenv
DENOVA_USERNAME=admin
DENOVA_PASSWORD=replace-with-your-own-password
DENOVA_IMAGE_TAG=latest
```

密码需为 1–72 个 UTF-8 字节。在仓库根目录执行，PowerShell 与 Bash 命令相同：

```sh
docker compose --env-file docker/.env -f docker/compose.yml up -d
```

打开 `http://localhost:8080`，使用上述账号登录。Compose 默认只发布宿主机回环地址；需要局域网访问时，将端口映射改为 `8080:8080`，需要互联网访问时配合 HTTPS 反向代理。

容器以 UID/GID `10001:10001` 运行，命名卷 `denova-data` 保存 `/data`，其中 `/data/.denova` 是应用数据、`/data/log` 是日志。手动绑定宿主目录时，需要让该 UID 有写权限。外部 Project 如需使用，应另外挂载其目录；命名卷不包含未挂载的宿主文件。

首次启动仅在数据目录没有 `config.toml` 时写入网络监听设置和 bcrypt 密码摘要；已有配置不会被覆盖。账号环境变量只用于首次初始化，之后更改密码应使用应用设置。导入旧数据时，需要确保其用户配置已启用 `allow_lan_access`，并设置 `remote_access_username` 与 `remote_access_password_hash`。不要在容器设置中关闭局域网访问，否则容器端口不可达。

更新容器使用以下命令；数据卷保留。不要使用应用内 updater 修改镜像内程序，也不要执行 `down -v`，后者会删除数据卷。

```sh
docker compose --env-file docker/.env -f docker/compose.yml pull
docker compose --env-file docker/.env -f docker/compose.yml up -d
```

回退时将 `DENOVA_IMAGE_TAG` 改为旧版本后重新创建容器。应用数据格式可能随版本变化，升级前应备份数据卷；回退镜像不等于回退数据。

## 验证入口

```sh
python -B -m unittest discover -s scripts -p test_sync_upstream_release.py
python -B -m unittest discover -s docker -p test_entrypoint.py
bash -n docker/smoke-test.sh
```

真实容器构建和双架构冒烟测试由上述发布工作流执行，使用隔离数据卷，不使用开发服务、真实模型配置或真实用户数据。PR 仅执行脚本测试与语法检查，不发布镜像。

参考：[GitHub 容器仓库权限与可见性](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)、[Docker 多平台构建](https://docs.docker.com/build/building/multi-platform/)、[GitHub 定时事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。
