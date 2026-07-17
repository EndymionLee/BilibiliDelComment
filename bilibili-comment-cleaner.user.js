// ==UserScript==
// @name         B站一键评论清理工具
// @namespace    https://github.com/your-username/bilibili-comment-cleaner
// @version      1.0.0
// @description  批量删除B站历史评论——通过 aicu.cc API 获取评论列表，调用B站官方接口逐条删除
// @author       EndymionLee
// @license      MIT
// @match        https://*.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      api.aicu.cc
// @connect      api.bilibili.com
// @run-at       document-end
// ==/UserScript==


(function () {
    'use strict';

    const CONFIG = {
        aicuApiBase: 'https://api.aicu.cc',
        aicuEndpoint: '/api/v3/search/getreply',
        biliDeleteApi: 'https://api.bilibili.com/x/v2/reply/del',
        biliNavApi: 'https://api.bilibili.com/x/web-interface/nav',
        pageSize: 100,
        defaultDelay: 1500,
        minDelay: 500,
        maxDelay: 10000,
    };

    const state = {
        uid: null,
        username: null,
        csrf: null,
        comments: [],
        totalCount: 0,
        deletedCount: 0,
        failedCount: 0,
        isDeleting: false,
        stopRequested: false,
        currentPage: 0,
        isFetching: false,
    };

    let $ = {
        panel: null,
        toggleBtn: null,
        themeBtn: null,
        statusEl: null,
        progressBar: null,
        progressText: null,
        progressWrap: null,
        btnFetch: null,
        btnDelete: null,
        btnStop: null,
        btnRefresh: null,
        delayInput: null,
        userRow: null,
        logEl: null,
        statTotal: null,
        statDeleted: null,
        statFailed: null,
    };

    function getCsrfFromCookie() {
        const match = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
        return match ? match[1] : null;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function formatTime(timestamp) {
        if (!timestamp) return '未知时间';
        const d = new Date(timestamp * 1000);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    function getCommentTypeLabel(type) {
        const map = {
            1: '视频',
            11: '图文动态',
            17: '文字动态',
            12: '直播',
        };
        return map[type] || `类型${type}`;
    }

    function decodeEntities(str) {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = str;
        return textarea.value;
    }

    function getResponseText(res) {

        if (res.responseText) return res.responseText;

        if (res.response && typeof res.response === 'object') return JSON.stringify(res.response);

        return res.response || '';
    }

    function parseJSON(res) {
        const text = getResponseText(res);
        if (!text) throw new Error(`响应为空 (HTTP ${res.status})`);
        return JSON.parse(text);
    }

    function checkStatus(res) {
        if (res.status >= 200 && res.status < 300) return;
        if (res.status === 0) return; 
        throw new Error(`HTTP ${res.status} ${res.statusText || ''}`);
    }

    function fetchUserInfo() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: CONFIG.biliNavApi,
                responseType: 'text',
                onload: (res) => {
                    try {
                        checkStatus(res);
                        const data = parseJSON(res);
                        if (data.code === 0 && data.data) {
                            resolve({
                                uid: data.data.mid,
                                username: data.data.uname,
                                isLogin: data.data.isLogin,
                            });
                        } else {
                            reject(new Error(data.message || '未登录或获取用户信息失败'));
                        }
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: () => reject(new Error('网络错误：获取用户信息失败')),
            });
        });
    }

    function requestWithRetry(url, options, maxRetries = 3) {
        return new Promise((resolve, reject) => {
            const doRequest = (attempt) => {
                GM_xmlhttpRequest({
                    ...options,
                    url: url,
                    onload: (res) => {
                        if (res.status === 429 || res.status === 503) {

                            if (attempt < maxRetries) {
                                const wait = Math.min(1000 * Math.pow(3, attempt), 27000);
                                appendLog(`aicu.cc 限流(429)，${Math.round(wait/1000)}秒后重试 (第${attempt+1}次)`, 'warn');
                                setTimeout(() => doRequest(attempt + 1), wait);
                            } else {
                                reject(new Error(`aicu.cc 请求被限流，已重试 ${maxRetries} 次仍失败`));
                            }
                            return;
                        }
                        resolve(res);
                    },
                    onerror: () => {
                        if (attempt < maxRetries) {
                            const wait = Math.min(1000 * Math.pow(3, attempt), 27000);
                            appendLog(`aicu.cc 请求失败，${Math.round(wait/1000)}秒后重试`, 'warn');
                            setTimeout(() => doRequest(attempt + 1), wait);
                        } else {
                            reject(new Error('网络错误：连接 aicu.cc 失败'));
                        }
                    },
                    ontimeout: () => {
                        if (attempt < maxRetries) {
                            const wait = Math.min(1000 * Math.pow(3, attempt), 27000);
                            appendLog(`aicu.cc 请求超时，${Math.round(wait/1000)}秒后重试`, 'warn');
                            setTimeout(() => doRequest(attempt + 1), wait);
                        } else {
                            reject(new Error('请求超时：aicu.cc 无响应'));
                        }
                    },
                });
            };
            doRequest(0);
        });
    }

    function fetchCommentsPage(uid, page) {
        return new Promise((resolve, reject) => {
            const url = `${CONFIG.aicuApiBase}${CONFIG.aicuEndpoint}?uid=${uid}&pn=${page}&ps=${CONFIG.pageSize}&mode=0`;
            requestWithRetry(url, {
                method: 'GET',
                responseType: 'text',
                headers: {
                    'User-Agent': navigator.userAgent,
                    'Accept': 'application/json, text/plain, */*',
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    'Referer': 'https://www.bilibili.com/',
                    'Cache-Control': 'no-cache',
                },
            }, 3).then((res) => {
                try {
                    checkStatus(res);
                    const data = parseJSON(res);
                    if (data.code === 0 && data.data) {
                        resolve({
                            replies: data.data.replies || [],
                            isEnd: data.data.cursor ? data.data.cursor.is_end : true,
                            allCount: data.data.cursor ? data.data.cursor.all_count : 0,
                        });
                    } else {
                        reject(new Error(data.message || `获取评论失败 (code: ${data.code})`));
                    }
                } catch (e) {
                    reject(new Error(`aicu.cc 接口错误: ${e.message} | HTTP ${res.status} | 响应预览: ${(getResponseText(res) || '').substring(0, 120)}`));
                }
            }).catch(reject);
        });
    }

    function fetchMsgCenterReplies(cursorId, replyTime) {
        return new Promise((resolve, reject) => {
            let url = 'https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web';
            if (cursorId && replyTime) {
                url += `&id=${cursorId}&reply_time=${replyTime}`;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'text',
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'Referer': 'https://www.bilibili.com/',
                },
                onload: (res) => {
                    try {
                        checkStatus(res);
                        const data = parseJSON(res);
                        if (data.code === 0 && data.data) {
                            resolve({
                                items: data.data.items || [],
                                cursor: data.data.cursor,
                            });
                        } else {
                            reject(new Error(data.message || `消息中心获取失败 (code: ${data.code})`));
                        }
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: () => reject(new Error('网络错误：连接B站消息中心失败')),
                ontimeout: () => reject(new Error('请求超时：B站消息中心无响应')),
            });
        });
    }

    async function fetchAllCommentsFromMsgCenter() {
        const allItems = [];
        let cursorId = null;
        let replyTime = null;
        let isEnd = false;
        let emptyRounds = 0;

        while (!isEnd && !state.stopRequested && emptyRounds < 3) {
            const result = await fetchMsgCenterReplies(cursorId, replyTime);
            const items = result.items || [];
            const cursor = result.cursor;

            if (items.length === 0) {
                emptyRounds++;
                if (cursor && cursor.is_end) isEnd = true;
                break;
            }

            for (const item of items) {
                if (item.item && item.item.reply) {
                    const reply = item.item.reply;
                    allItems.push({
                        rpid: reply.rpid,
                        oid: reply.oid,
                        type: reply.type,
                        message: reply.content ? reply.content.message : '',
                        time: reply.ctime,
                        dyn: { oid: reply.oid, type: reply.type },
                        _source: 'msgcenter',
                    });
                }
            }

            updateStatus(`消息中心: 已获取 ${allItems.length} 条评论`);

            if (cursor) {
                isEnd = cursor.is_end;
                cursorId = cursor.id;
                replyTime = cursor.time;
            } else {
                break;
            }

            await sleep(500);
        }

        const seen = new Set();
        const unique = [];
        for (const item of allItems) {
            if (!seen.has(item.rpid)) {
                seen.add(item.rpid);
                unique.push(item);
            }
        }

        return unique;
    }

    function deleteSingleComment(type, oid, rpid, csrf) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: CONFIG.biliDeleteApi,
                responseType: 'text',
                data: `type=${type}&oid=${oid}&rpid=${rpid}&csrf=${csrf}`,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                onload: (res) => {
                    try {
                        checkStatus(res);
                        const data = parseJSON(res);
                        if (data.code === 0) {
                            resolve(true);
                        } else if (data.code === 12022) {

                            resolve(true);
                        } else if (data.code === -111) {
                            reject(new Error('CSRF 校验失败，请刷新页面重试'));
                        } else if (data.code === -101) {
                            reject(new Error('登录态失效，请重新登录'));
                        } else if (data.code === -509) {
                            reject(new Error('请求太频繁，触发风控'));
                        } else {
                            reject(new Error(data.message || `删除失败 (code: ${data.code})`));
                        }
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: () => reject(new Error('网络错误：删除请求失败')),
                ontimeout: () => reject(new Error('删除请求超时')),
            });
        });
    }

    async function fetchAllComments(uid) {
        let allReplies = [];
        let page = 1;
        let isEnd = false;
        let totalKnown = 0;
        let partial = false;

        while (!isEnd && !state.stopRequested) {
            updateStatus(`正在获取第 ${page} 页评论...`);
            try {
                const result = await fetchCommentsPage(uid, page);
                const replies = result.replies;
                isEnd = result.isEnd;
                totalKnown = result.allCount;

                const existingIds = new Set(allReplies.map(r => r.rpid));
                const newReplies = replies.filter(r => !existingIds.has(r.rpid));
                allReplies = allReplies.concat(newReplies);

                updateStatus(`已获取 ${allReplies.length} / ${totalKnown || '?'} 条评论`);

                if (replies.length < CONFIG.pageSize) {
                    break;
                }
                page++;

                const pause = 2000 + Math.random() * 1000;
                await sleep(pause);
            } catch (err) {

                if (allReplies.length > 0) {
                    partial = true;
                    appendLog(`第 ${page} 页获取失败，但已有 ${allReplies.length} 条可用`, 'warn');
                    break;
                }

                throw err;
            }
        }

        return { replies: allReplies, total: totalKnown, partial };
    }

    async function batchDelete(comments) {
        const delay = parseInt($.delayInput.value, 10) || CONFIG.defaultDelay;
        const csrf = getCsrfFromCookie();

        if (!csrf) {
            appendLog('错误：无法获取 CSRF token (bili_jct)，请确认已登录B站');
            return;
        }

        state.isDeleting = true;
        state.stopRequested = false;
        state.deletedCount = 0;
        state.failedCount = 0;
        state.totalCount = comments.length;

        toggleButtons(false);

        const startTime = Date.now();

        for (let i = 0; i < comments.length; i++) {
            if (state.stopRequested) {
                appendLog('用户已中断删除操作');
                break;
            }

            const c = comments[i];
            const rpid = c.rpid;
            const oid = c.dyn ? c.dyn.oid : c.oid;
            const type = c.dyn ? c.dyn.type : c.type;

            try {
                await deleteSingleComment(type, oid, rpid, csrf);
                state.deletedCount++;
            } catch (err) {
                state.failedCount++;
                appendLog(`[失败] ${err.message} (rpid: ${rpid})`);
            }

            const progress = ((i + 1) / comments.length) * 100;
            updateProgress(progress, i + 1);

            if (i < comments.length - 1 && !state.stopRequested) {

                const jitter = delay * (0.8 + Math.random() * 0.4);
                await sleep(jitter);
            }
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        state.isDeleting = false;
        toggleButtons(true);

        const summary = `完成！成功删除 ${state.deletedCount} 条，失败 ${state.failedCount} 条，耗时 ${elapsed}秒`;
        appendLog(summary);
        updateStatus(summary);
        updateStats();
    }


    const THEME_STORAGE_KEY = 'bcc_theme';

    function getStoredTheme() {
        return GM_getValue(THEME_STORAGE_KEY, 'light');
    }

    function setStoredTheme(theme) {
        GM_setValue(THEME_STORAGE_KEY, theme);
    }

    const STYLES = `

        #bcc-panel {
            --bg-primary: #ffffff;
            --bg-secondary: #f5f5f7;
            --bg-tertiary: #e8e8ed;
            --text-primary: #1d1d1f;
            --text-secondary: #6e6e73;
            --text-muted: #98989d;
            --border-color: #e0e0e0;
            --shadow: rgba(0,0,0,0.1);
            --accent: #00a8a0;
            --accent-hover: #00968f;
            --danger: #ff3b30;
            --danger-hover: #e6352b;
            --warn: #f5a623;
            --warn-hover: #e0961a;
            --info: #40a0ff;
            --scrollbar: #d0d0d0;
            --log-bg: #f8f8fa;
            --toggle-bg: #ffffff;
        }
        #bcc-panel.bcc-dark {
            --bg-primary: #1c1c1e;
            --bg-secondary: #2c2c2e;
            --bg-tertiary: #3a3a3c;
            --text-primary: #f0f0f0;
            --text-secondary: #98989d;
            --text-muted: #6e6e73;
            --border-color: #3a3a3c;
            --shadow: rgba(0,0,0,0.4);
            --scrollbar: #48484a;
            --log-bg: #111113;
            --toggle-bg: #1c1c1e;
        }

        #bcc-panel {
            all: initial;
            position: fixed;
            top: 80px;
            right: 20px;
            width: 360px;
            max-height: 80vh;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
            font-size: 13px;
            line-height: 1.5;
            border-radius: 14px;
            box-shadow: 0 8px 40px var(--shadow);
            z-index: 2147483647;
            overflow: hidden;
            display: none;
            border: 1px solid var(--border-color);
        }
        #bcc-panel.bcc-show { display: block; }
        #bcc-panel * {
            all: revert;
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        #bcc-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            cursor: move;
            user-select: none;
            border-bottom: 1px solid var(--border-color);
        }
        #bcc-header h2 {
            font-size: 14px;
            font-weight: 600;
            color: var(--text-primary);
            margin: 0;
        }
        #bcc-header-actions {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        #bcc-header-actions button {
            background: none;
            border: 1px solid var(--border-color);
            color: var(--text-muted);
            border-radius: 6px;
            padding: 2px 8px;
            font-size: 11px;
            cursor: pointer;
            font-family: inherit;
            line-height: 1.6;
            transition: all 0.15s;
        }
        #bcc-header-actions button:hover {
            background: var(--bg-secondary);
            color: var(--text-primary);
        }
        #bcc-close {
            font-size: 18px !important;
            padding: 2px 6px !important;
            font-family: serif !important;
            border: none !important;
        }
        #bcc-close:hover { color: var(--danger) !important; }

        #bcc-body {
            padding: 12px 16px 16px;
            overflow-y: auto;
            max-height: calc(80vh - 44px);
        }
        #bcc-body::-webkit-scrollbar { width: 4px; }
        #bcc-body::-webkit-scrollbar-track { background: transparent; }
        #bcc-body::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 2px; }

        #bcc-user-row {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 0 0 12px 0;
            border-bottom: 1px solid var(--border-color);
            margin-bottom: 12px;
        }
        #bcc-user-row .bcc-avatar {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: var(--accent);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            color: #fff;
            flex-shrink: 0;
            font-weight: 600;
        }
        #bcc-user-row .bcc-user-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
        #bcc-user-row .bcc-user-uid { font-size: 11px; color: var(--text-muted); }

        #bcc-action-bar {
            display: flex;
            gap: 10px;
            margin-bottom: 10px;
        }
        #bcc-stats {
            display: flex;
            gap: 4px;
            flex-shrink: 0;
        }
        .bcc-stat-tag {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 0 10px;
            height: 32px;
            background: var(--bg-secondary);
            border-radius: 8px;
            font-size: 12px;
            color: var(--text-secondary);
        }
        .bcc-stat-tag .num { font-weight: 700; color: var(--text-primary); min-width: 20px; text-align: center; }
        .bcc-stat-tag.deleted .num { color: var(--accent); }
        .bcc-stat-tag.failed .num { color: var(--danger); }

        #bcc-main-actions {
            display: flex;
            gap: 6px;
            flex: 1;
        }
        #bcc-main-actions .bcc-btn {
            flex: 1;
            height: 32px;
            padding: 0 12px;
            border: none;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.15s;
            white-space: nowrap;
        }
        #bcc-main-actions .bcc-btn:disabled { opacity: 0.35; cursor: not-allowed; }
        #bcc-main-actions .bcc-btn-primary { background: var(--accent); color: #fff; }
        #bcc-main-actions .bcc-btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
        #bcc-main-actions .bcc-btn-danger { background: var(--danger); color: #fff; }
        #bcc-main-actions .bcc-btn-danger:hover:not(:disabled) { background: var(--danger-hover); }
        #bcc-main-actions .bcc-btn-warning { background: var(--warn); color: #fff; }
        #bcc-main-actions .bcc-btn-warning:hover:not(:disabled) { background: var(--warn-hover); }

        #bcc-sub-actions {
            display: flex;
            gap: 6px;
            margin-bottom: 10px;
        }
        #bcc-sub-actions .bcc-btn {
            flex: 1;
            height: 28px;
            padding: 0 10px;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s;
            background: transparent;
            color: var(--text-secondary);
        }
        #bcc-sub-actions .bcc-btn:disabled { opacity: 0.35; cursor: not-allowed; }
        #bcc-sub-actions .bcc-btn:hover:not(:disabled) {
            background: var(--bg-secondary);
            color: var(--text-primary);
        }

        #bcc-progress-wrap {
            display: none;
            margin-bottom: 10px;
        }
        #bcc-progress-wrap.bcc-show { display: block; }
        #bcc-progress-bar {
            width: 100%;
            height: 4px;
            background: var(--bg-tertiary);
            border-radius: 2px;
            overflow: hidden;
        }
        #bcc-progress-bar .fill {
            height: 100%;
            width: 0%;
            background: linear-gradient(90deg, var(--accent), #66d9d0);
            border-radius: 2px;
            transition: width 0.3s ease;
        }
        #bcc-progress-text {
            font-size: 11px;
            color: var(--text-muted);
            margin-top: 3px;
            text-align: right;
        }

        #bcc-settings {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            background: var(--bg-secondary);
            border-radius: 8px;
            margin-bottom: 10px;
        }
        #bcc-settings label { font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
        #bcc-settings input {
            background: var(--bg-primary);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            color: var(--text-primary);
            padding: 3px 6px;
            width: 64px;
            font-size: 12px;
            text-align: center;
        }
        #bcc-settings input:focus { outline: none; border-color: var(--accent); }
        #bcc-settings .hint { font-size: 11px; color: var(--text-muted); }

        #bcc-status {
            padding: 6px 10px;
            background: var(--bg-secondary);
            border-radius: 8px;
            font-size: 12px;
            color: var(--text-secondary);
            min-height: 28px;
            margin-bottom: 8px;
            line-height: 1.6;
        }
        #bcc-status.bcc-loading { color: var(--accent); }
        #bcc-status.bcc-error { color: var(--danger); }
        #bcc-status.bcc-success { color: var(--accent); }

        #bcc-log {
            max-height: 120px;
            overflow-y: auto;
            padding: 6px 10px;
            background: var(--log-bg);
            border-radius: 8px;
            font-size: 11px;
            font-family: 'SF Mono', 'Consolas', 'Courier New', monospace;
            line-height: 1.7;
        }
        #bcc-log::-webkit-scrollbar { width: 4px; }
        #bcc-log::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 2px; }
        .bcc-log-line { color: var(--text-muted); }
        .bcc-log-line.error { color: var(--danger); }
        .bcc-log-line.success { color: var(--accent); }
        .bcc-log-line.info { color: var(--info); }
        .bcc-log-line.warn { color: var(--warn); }

        #bcc-toggle {
            position: fixed;
            top: 80px;
            right: 20px;
            width: 44px;
            height: 44px;
            background: #00a8a0;
            color: #ffffff;
            border-radius: 50%;
            font-size: 16px;
            font-weight: 700;
            cursor: grab;
            z-index: 2147483646;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 16px rgba(0, 168, 160, 0.35);
            transition: box-shadow 0.2s, transform 0.15s;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            user-select: none;
            touch-action: none;
        }
        #bcc-toggle:hover {
            box-shadow: 0 6px 24px rgba(0, 168, 160, 0.5);
            transform: scale(1.06);
        }
        #bcc-toggle:active {
            cursor: grabbing;
            transform: scale(0.95);
        }
        #bcc-toggle.bcc-hidden { display: none; }
    `;

    function applyTheme(theme) {
        if (theme === 'dark') {
            $.panel.classList.add('bcc-dark');
            $.themeBtn.textContent = 'L';
            $.themeBtn.title = '切换到白色主题';
        } else {
            $.panel.classList.remove('bcc-dark');
            $.themeBtn.textContent = 'D';
            $.themeBtn.title = '切换到黑色主题';
        }
    }

    function toggleTheme() {
        const current = $.panel.classList.contains('bcc-dark') ? 'dark' : 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        setStoredTheme(next);
    }

    function createUI() {

        GM_addStyle(STYLES);

        const toggleBtn = document.createElement('div');
        toggleBtn.id = 'bcc-toggle';
        toggleBtn.textContent = '[C]';
        toggleBtn.title = '打开评论清理工具';
        toggleBtn.style.fontSize = '16px';
        toggleBtn.style.fontWeight = 'bold';
        document.body.appendChild(toggleBtn);

        const panel = document.createElement('div');
        panel.id = 'bcc-panel';
        panel.innerHTML = `
            <div id="bcc-header">
                <h2>评论清理工具</h2>
                <div id="bcc-header-actions">
                    <button id="bcc-theme-btn">D</button>
                    <button id="bcc-close">&times;</button>
                </div>
            </div>
            <div id="bcc-body">
                <!-- 用户信息 -->
                <div id="bcc-user-row">
                    <div class="bcc-avatar">?</div>
                    <div>
                        <div class="bcc-user-name">未检测</div>
                        <div class="bcc-user-uid">UID: -</div>
                    </div>
                </div>

                <!-- 统计 + 主按钮 -->
                <div id="bcc-action-bar">
                    <div id="bcc-stats">
                        <span class="bcc-stat-tag">
                            总计 <span class="num" id="bcc-stat-total">0</span>
                        </span>
                        <span class="bcc-stat-tag deleted">
                            <span class="num" id="bcc-stat-deleted">0</span>
                        </span>
                        <span class="bcc-stat-tag failed">
                            <span class="num" id="bcc-stat-failed">0</span>
                        </span>
                    </div>
                    <div id="bcc-main-actions">
                        <button id="bcc-btn-fetch" class="bcc-btn bcc-btn-primary">获取评论</button>
                        <button id="bcc-btn-delete" class="bcc-btn bcc-btn-danger" disabled>删除</button>
                    </div>
                </div>

                <!-- 辅助按钮 -->
                <div id="bcc-sub-actions">
                    <button id="bcc-btn-stop" class="bcc-btn" disabled>停止</button>
                    <button id="bcc-btn-refresh" class="bcc-btn">刷新登录态</button>
                </div>

                <!-- 进度 -->
                <div id="bcc-progress-wrap">
                    <div id="bcc-progress-bar"><div class="fill"></div></div>
                    <div id="bcc-progress-text">0 / 0</div>
                </div>

                <!-- 设置 -->
                <div id="bcc-settings">
                    <label>删除间隔</label>
                    <input type="number" id="bcc-delay" value="${CONFIG.defaultDelay}" min="${CONFIG.minDelay}" max="${CONFIG.maxDelay}" step="100">
                    <span class="hint">ms</span>
                </div>

                <!-- 状态 -->
                <div id="bcc-status">就绪，点击「获取评论」开始</div>

                <!-- 日志 -->
                <div id="bcc-log">
                    <div class="bcc-log-line info">工具已加载</div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        $.panel = panel;
        $.toggleBtn = toggleBtn;
        $.themeBtn = document.getElementById('bcc-theme-btn');
        $.statusEl = document.getElementById('bcc-status');
        $.progressBar = document.querySelector('#bcc-progress-bar .fill');
        $.progressText = document.getElementById('bcc-progress-text');
        $.progressWrap = document.getElementById('bcc-progress-wrap');
        $.btnFetch = document.getElementById('bcc-btn-fetch');
        $.btnDelete = document.getElementById('bcc-btn-delete');
        $.btnStop = document.getElementById('bcc-btn-stop');
        $.btnRefresh = document.getElementById('bcc-btn-refresh');
        $.delayInput = document.getElementById('bcc-delay');
        $.userRow = document.getElementById('bcc-user-row');
        $.logEl = document.getElementById('bcc-log');
        $.statTotal = document.getElementById('bcc-stat-total');
        $.statDeleted = document.getElementById('bcc-stat-deleted');
        $.statFailed = document.getElementById('bcc-stat-failed');

        applyTheme(getStoredTheme());

        document.getElementById('bcc-close').addEventListener('click', hidePanel);

        $.themeBtn.addEventListener('click', toggleTheme);

        makeToggleDraggable(toggleBtn, () => {
            if (panel.classList.contains('bcc-show')) {
                hidePanel();
            } else {
                showPanel();
            }
        });

        makeDraggable(panel, document.getElementById('bcc-header'));

        $.btnFetch.addEventListener('click', onFetchComments);
        $.btnDelete.addEventListener('click', onDeleteAll);
        $.btnStop.addEventListener('click', onStop);
        $.btnRefresh.addEventListener('click', onRefreshLogin);

        setTimeout(() => onRefreshLogin(), 500);
    }

    function showPanel() {
        $.panel.classList.add('bcc-show');
        $.toggleBtn.classList.add('bcc-hidden');
    }

    function hidePanel() {
        $.panel.classList.remove('bcc-show');
        $.toggleBtn.classList.remove('bcc-hidden');
    }

    function makeDraggable(panel, handle) {
        let isDragging = false;
        let startX, startY, origX, origY;

        handle.addEventListener('mousedown', (e) => {
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            origX = rect.left;
            origY = rect.top;
            panel.style.left = origX + 'px';
            panel.style.right = 'auto';
            panel.style.top = origY + 'px';

            const onMove = (ev) => {
                if (!isDragging) return;
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                panel.style.left = (origX + dx) + 'px';
                panel.style.top = (origY + dy) + 'px';
            };
            const onUp = () => {
                isDragging = false;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    function makeToggleDraggable(el, onClick) {
        let isDragging = false;
        let startX, startY, origX, origY;
        let moved = false;

        el.addEventListener('mousedown', (e) => {
            isDragging = true;
            moved = false;
            const rect = el.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            origX = rect.left;
            origY = rect.top;
            el.style.left = origX + 'px';
            el.style.right = 'auto';
            el.style.top = origY + 'px';
            el.style.bottom = 'auto';
            el.style.transition = 'none';

            const onMove = (ev) => {
                if (!isDragging) return;
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
                el.style.left = (origX + dx) + 'px';
                el.style.top = (origY + dy) + 'px';
            };
            const onUp = () => {
                isDragging = false;
                el.style.transition = 'box-shadow 0.2s, transform 0.15s';
                if (!moved && onClick) {
                    onClick();
                }
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }


    function updateStatus(msg, type) {
        $.statusEl.textContent = msg;
        $.statusEl.className = '';
        if (type) $.statusEl.classList.add(type);
    }

    function appendLog(msg, type) {
        const line = document.createElement('div');
        line.className = 'bcc-log-line ' + (type || 'info');
        const time = new Date().toLocaleTimeString();
        line.textContent = `[${time}] ${msg}`;
        $.logEl.appendChild(line);
        $.logEl.scrollTop = $.logEl.scrollHeight;

        while ($.logEl.children.length > 200) {
            $.logEl.removeChild($.logEl.firstChild);
        }
    }

    function updateProgress(percent, current) {
        $.progressBar.style.width = Math.min(percent, 100) + '%';
        $.progressText.textContent = `${current} / ${state.totalCount}`;
    }

    function updateStats() {
        $.statTotal.textContent = state.comments.length;
        $.statDeleted.textContent = state.deletedCount;
        $.statFailed.textContent = state.failedCount;
    }

    function toggleButtons(enabled) {
        $.btnFetch.disabled = !enabled || state.isFetching;
        $.btnDelete.disabled = !enabled || state.comments.length === 0;
        $.btnStop.disabled = enabled;
        $.btnRefresh.disabled = !enabled;
        if (state.isFetching) {
            $.btnFetch.disabled = true;
        }
    }

    function updateUserInfo(uid, username) {
        const avatar = $.userRow.querySelector('.bcc-avatar');
        const nameEl = $.userRow.querySelector('.bcc-user-name');
        const uidEl = $.userRow.querySelector('.bcc-user-uid');
        avatar.textContent = username ? username.charAt(0).toUpperCase() : '?';
        nameEl.textContent = username || '未知用户';
        uidEl.textContent = `UID: ${uid || '-'}`;
    }


    async function onRefreshLogin() {
        try {
            updateStatus('正在检测登录态...', '');
            appendLog('正在获取用户信息...', 'info');
            const info = await fetchUserInfo();
            if (!info.isLogin) {
                updateStatus('未登录B站，请先登录', 'bcc-error');
                appendLog('未登录B站，请先登录', 'error');
                return;
            }
            state.uid = info.uid;
            state.username = info.username;
            state.csrf = getCsrfFromCookie();
            updateUserInfo(info.uid, info.username);
            updateStatus(`已登录：${info.username}`, 'bcc-success');
            appendLog(`用户信息获取成功：${info.username} (UID: ${info.uid})`, 'success');
            if (!state.csrf) {
                appendLog('警告：未检测到 CSRF token，删除功能不可用', 'warn');
            }
        } catch (err) {
            updateStatus(err.message, 'bcc-error');
            appendLog(`获取用户信息失败：${err.message}`, 'error');
        }
    }

    async function onFetchComments() {
        if (!state.uid) {
            updateStatus('请先点击「刷新登录态」获取用户信息', 'bcc-error');
            return;
        }

        if (state.isFetching) return;
        state.isFetching = true;
        state.stopRequested = false;
        $.btnFetch.disabled = true;
        $.btnFetch.textContent = '获取中...';

        try {

            updateStatus('正在连接 aicu.cc 获取评论数据...', 'bcc-loading');
            appendLog(`开始获取 UID ${state.uid} 的评论历史...`, 'info');

            const result = await fetchAllComments(state.uid);
            state.comments = result.replies;
            state.deletedCount = 0;
            state.failedCount = 0;

            updateStats();
            $.progressWrap.classList.remove('bcc-show');

            if (state.comments.length === 0) {
                updateStatus('没有找到历史评论', 'bcc-success');
                appendLog('没有找到可删除的历史评论', 'warn');
                $.btnDelete.disabled = true;
                return;
            }

            const sourceLabel = result.partial ? `aicu.cc (部分, ${result.total || '?'}条中获取到${state.comments.length}条)` : `aicu.cc`;
            updateStatus(`共获取 ${state.comments.length} 条评论`, 'bcc-success');
            appendLog(`成功获取 ${state.comments.length} 条评论，来自 ${sourceLabel}`, result.partial ? 'warn' : 'success');
            $.btnDelete.disabled = false;

            const previews = state.comments.slice(0, 5);
            previews.forEach(c => {
                const msg = decodeEntities(c.message || '').substring(0, 60);
                appendLog(`[${getCommentTypeLabel(c.dyn ? c.dyn.type : c.type)}] ${msg}`, 'info');
            });
            if (state.comments.length > 5) {
                appendLog(`... 还有 ${state.comments.length - 5} 条评论`, 'info');
            }
            return;
        } catch (err) {

            appendLog(`aicu.cc 获取失败: ${err.message}`, 'error');
            updateStatus('aicu.cc 不可用，尝试B站消息中心...', 'bcc-loading');

            try {
                appendLog('正在从B站消息中心获取评论（仅覆盖有互动的评论）...', 'info');
                const msgComments = await fetchAllCommentsFromMsgCenter();
                state.comments = msgComments;
                state.deletedCount = 0;
                state.failedCount = 0;
                updateStats();
                $.progressWrap.classList.remove('bcc-show');

                if (state.comments.length === 0) {
                    updateStatus('两个数据源均无评论可获取', 'bcc-error');
                    appendLog('aicu.cc 和 B站消息中心均未找到评论', 'error');
                    $.btnDelete.disabled = true;
                } else {
                    updateStatus(`消息中心: 找到 ${state.comments.length} 条评论`, 'bcc-success');
                    appendLog(`从B站消息中心获取到 ${state.comments.length} 条评论`, 'success');
                    $.btnDelete.disabled = false;

                    const previews = state.comments.slice(0, 5);
                    previews.forEach(c => {
                        const msg = decodeEntities(c.message || '').substring(0, 60);
                        appendLog(`[${getCommentTypeLabel(c.dyn ? c.dyn.type : c.type)}] ${msg}`, 'info');
                    });
                    if (state.comments.length > 5) {
                        appendLog(`... 还有 ${state.comments.length - 5} 条评论`, 'info');
                    }
                }
            } catch (msgErr) {
                updateStatus('所有数据源均获取失败', 'bcc-error');
                appendLog(`消息中心也获取失败: ${msgErr.message}`, 'error');
            }
        } finally {
            state.isFetching = false;
            $.btnFetch.disabled = false;
            $.btnFetch.textContent = '获取评论';
            toggleButtons(true);
        }
    }

    async function onDeleteAll() {
        if (state.comments.length === 0) {
            updateStatus('没有可删除的评论', 'bcc-error');
            return;
        }
        if (state.isDeleting) return;

        const csrf = getCsrfFromCookie();
        if (!csrf) {
            updateStatus('CSRF token 丢失，请刷新页面', 'bcc-error');
            appendLog('CSRF token 丢失，请刷新B站页面后重试', 'error');
            return;
        }

        if (!confirm(`确认要删除全部 ${state.comments.length} 条评论吗？\n\n此操作不可恢复！\n建议先删除少量测试，确认正常后再批量操作。`)) {
            return;
        }

        if (state.comments.length > 50) {
            if (!confirm(`你确定要删除 ${state.comments.length} 条评论吗？\n\n数量较大，建议分批次执行（如先删前50条）。\n\n点「取消」返回，点「确定」全部删除。`)) {
                return;
            }
        }

        $.progressWrap.classList.add('bcc-show');
        updateProgress(0, 0);
        appendLog(`开始删除 ${state.comments.length} 条评论...`, 'warn');
        updateStatus('正在删除...', 'bcc-loading');

        await batchDelete(state.comments);

        // 移除已处理（成功+失败）的条目，剩余的可继续删
        const processed = state.deletedCount + state.failedCount;
        if (processed > 0) {
            state.comments = state.comments.slice(processed);
        }
        const remaining = state.comments.length;
        if (remaining > 0) {
            appendLog(`剩余 ${remaining} 条未处理，可继续删除`, 'info');
        }
        updateStats();
    }

    function onStop() {
        if (state.isDeleting) {
            state.stopRequested = true;
            appendLog('正在停止...（等待当前删除完成）', 'warn');
            updateStatus('正在停止...', '');
        }
    }


    function init() {
        createUI();
        appendLog('B站评论清理工具 v1.0 已加载', 'info');
        appendLog('提示：首次使用请点击「刷新登录态」', 'info');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

