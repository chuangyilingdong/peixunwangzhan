# 容器宿主（跑学生 dsh 容器的机器）

平台生产机**跑不了容器**（2 vCPU / 1.6GB、没装 docker，实测），所以学生容器放在**单独一台机器**上，
这台机器只干一件事：按平台指令跑/停学生容器。平台仍在生产机上，两者之间只有一个脚本接口。

## 这台机器要什么

- 一台能装 docker 的 Linux（Ubuntu / Debian 都行），**root 可登**；
- 内存按「一人 2GB、10 人同时上课 ≈ 20GB」估，CPU 按「一人 2 vCPU」估（可在脚本里调）；
- 磁盘：镜像约 1.5GB + 每个学生容器的可写层（一节课几十~几百 MB，删容器即回收）；
- 网络：**出口**能到平台（`GATEWAY_BASE_URL`，走公网 HTTPS 即可），**入口**只需要平台能访问
  脚本分配的那段宿主端口（默认只绑回环，见下）。

## 装

```bash
# 在宿主上（root）
scp dsh-student.tar root@<宿主>:/root/          # 镜像从开发机 export / 或宿主上直接 build
ssh root@<宿主> 'bash -s' < provision.sh /root/dsh-student.tar
```

`provision.sh` 会：装 docker（用发行版自带的 `docker.io`，不依赖 download.docker.com）、建 `/srv/dsh-runtime`、
写 `daemon.json`（日志轮转 + live-restore）、导入镜像、跑一遍 `smoke-test.sh` 自检。

**镜像怎么上机器**：本地构建（见 `../README.md`）后
`docker save dsh-student:local -o dsh-student.tar`，再按上面 scp 过去；宿主自己没有 npm 源也能装。

## 用（平台与宿主之间唯一的接口）

```bash
# 起一个学生容器：平台签发运行时密钥后调这一条
bash run-student-container.sh \
  --session <课堂id> --student <学生id> \
  --key <平台签发的运行时密钥> \
  --gateway http://<平台>/api/gateway/v1 \
  --ticket <平台签发的短时票据>

# 输出（stdout，平台直接解析）
CONTAINER_NAME=dsh-s-<课堂>-<学生>
HOST_PORT=18100
EDGE_URL=http://127.0.0.1:18100/?t=<票据>
```

```bash
# 停
bash stop-student-container.sh --session <课堂id>      # 或 --student / --name / --all
# 兜底回收（建议 cron，每 5 分钟）
MAX_AGE_MINUTES=180 bash reap-idle.sh
# 自检
GATEWAY_URL=http://<平台>/api/gateway/v1 RUNTIME_KEY=<rt1...> bash smoke-test.sh
```

## 硬约束（都在脚本里，改脚本时别改掉）

1. **`--tmpfs /tmp:...,exec` 里的 `exec` 不能省**。docker 的 `--tmpfs` 默认带 `noexec`
   （实测 `rw,nosuid,nodev,noexec`），dsh 启动要在 `/tmp` 落一个原生模块回退加载器，
   noexec 会让它加载不上 → 整个插件树报 `Cannot find package '@linxin666/dsh-web-all'`、界面根本起不来。
2. **端口只绑 `BIND_HOST`（默认回环）**，端口池默认 `18100-18163`，方便防火墙只放这一段；
   学生浏览器应该由平台那侧转发进来，不是直连宿主。
3. **资源上限必须有**：默认 2 vCPU / 2GB / 512 pids。没有上限，一个学生的死循环能把整台机器拖死。
4. **回收的主力在平台那侧**（课堂结束、学生被移出名单时平台知道），`reap-idle.sh` 只是兜底；
   只靠它等于「学生下课 3 小时后容器才没」。
5. `reap-idle.sh` 读 `docker inspect` 的 `StartedAt`（UTC），**别把结尾的 `Z` 截掉** ——
   截掉后 `date` 按当地时间解释，东八区下每个容器都"已经跑了 8 小时"，第一个 cron 周期就把学生全踢了（实测踩到）。
6. 停止只删带 `dsh.runtime=student` 标签的容器，宿主上别的东西一概不动。

## 平台那侧还差什么（下一步，见交接文档）

- **拉起**：平台在「课堂开始 / 学生进入」时签发运行时密钥 + 票据，调 `run-student-container.sh`，把 `EDGE_URL` 给学生；
  跨机调用方式（平台机 → 宿主的 ssh，还是宿主上跑一个受控的小接口）需要在部署时定下来。
- **工作区预选**：现在学生进 dsh 要手动选一次工作区；应由平台建会话时预选 `/home/student/workspace`。
- **产物取回**：dsh 的 `deliverables/presented` 事件 → 平台现有 `/submit`（按产物、版权确认、只允许网页/PPT/Word/Excel）。
