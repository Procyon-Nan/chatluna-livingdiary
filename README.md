# chatluna-plugin-livingdiary

让机器人在 QQ 空间记录和分享日常。可以用命令读动态、发说说，也可以让对话中的机器人帮你发布。

## 使用

在插件配置的 `allowUserIds` 中填入可以操作空间的 QQ 号。登录态取自实例中已上线的 OneBot 或 Milky 机器人；有多个账号时，用 `selfId` 指定要使用的空间。

| 命令 | 用途 |
| --- | --- |
| `qzone.status` | 查看空间登录态、最近一次日记的结果和自动互动的运行情况 |
| `qzone.feeds 3` | 读取机器人最近 3 条动态 |
| `qzone.feeds 3 -t 123456` | 读取指定 QQ 号的可见动态 |
| `qzone.publish 今天下雨了` | 发布到机器人的空间；同一条消息可附最多 9 张图片，也可以只发图 |
| `qzone.digest` | 根据今天的记忆写日记；模型决定发布时会直接发到空间 |

开启 `enablePublishTool` 后，白名单用户也可以在对话里让机器人发说说。比如「把这张照片发到空间，配文写『雨停了』」。只有本次请求者的白名单权限有效；同群其他人的权限不能代用。

如果提示无法确认是否发布成功，先用 `qzone.feeds` 核对，以免重复发布。

## 每日日记

启用 LivingMemory，在 LivingDiary 配置中选择空间预设（`personaPresetId`）和写日记的模型（`mainModel`）。白名单用户可以发送 `qzone.digest` 立即写一篇。想让机器人自己按时写，就打开 `enableDailyDigest`，并设置 `digestTime`（默认服务器本地时间 23:50）。

机器人以所选预设的口吻写作，参考这个预设从今天零点到任务开始时新建、且仍然活跃的记忆。编辑旧记忆不会改变创建日期；Dream 合并或拆分生成的新条目按新条目的创建日期计算。默认最多使用最近 100 条，可通过 `digestMemoryLimit` 调整。当日没有记忆，或模型认为没有值得分享的内容，就跳过发布。

## 自动评论和回复

在插件配置中选择空间人设（`personaPresetId`）和互动模型（`subModel`）。在「自动互动」的 `interactionAllowUserIds` 中填写希望机器人互动的 QQ 号。这份名单独立于命令白名单；默认名单为空，机器人不会主动互动。自动互动不需要 LivingMemory。

| 想让机器人做什么 | 怎么配置 |
| --- | --- |
| 主动评论好友新发的动态 | 开启 `enableFriendPostComment`，模型会根据动态内容决定评论或跳过。 |
| 回复自己空间下的新评论 | 将 `interactionMonitorPostLimit` 设为大于 0 的数，默认关注 10 条动态。机器人在好友动态下发过一级评论时，也会跟进该评论线程里的新回复。 |
| 只评论新动态，不跟进回复 | 开启好友动态评论，把 `interactionMonitorPostLimit` 设为 0。 |
| 允许与所有可见用户互动 | 关闭 `enableInteractionWhitelist`。 |

机器人上线后先记住已有的动态和评论，从下一轮开始处理新增内容。插件重启时重新建立起点，不补发停机期间的评论。默认每 60 分钟检查一次，每轮最多发起 5 次评论或回复，可分别调整 `interactionPollIntervalMinutes` 和 `interactionMaxWritesPerRound`。用 `qzone.status` 可以查看待处理数量、已受理和结果待核对的写入次数。

如果希望机器人看懂动态配图，可以选择支持图片输入的互动模型；使用纯文本互动模型时，也可以为 ChatLuna 的 `@vision` 角色配置读图模型。每次互动最多读取 9 张托管在 QQ 空间图片域名下的配图，单张上限 15 MiB，合计 45 MiB。GIF 按需抽帧，视频、音频和文件只提供类型、名称等信息。

## 构建

在插件目录运行 `yarn build`。

## 发布

更新 `package.json` 中的版本号后，在插件目录运行 `npm run pub`。脚本会清理旧产物、重新构建，并将该版本发布到 npm 公共仓库。
