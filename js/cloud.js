/* 云端每日存档：一个日期 = 一份存档（按 space_id + save_date 覆盖式写入）。
 * 本地 IndexedDB 始终是主存储；云端不可用时不静默丢数据，标为「待同步」等待重试。
 */
(function () {
  'use strict';

  var cloud = null;
  var ready = false;
  var reason = '云端未连接';

  function init() {
    var cfg = window.YW_PUBLIC_CONFIG;
    if (!window.WorkBuddyCloud || !window.WorkBuddyCloud.createWorkBuddyCloud) {
      reason = '云端组件没加载上（离线或网络受限），已存本地';
      return false;
    }
    try {
      cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: cfg.endpoint,
        oauthRelayBaseUrl: cfg.oauthRelayBaseUrl,
        publishableKey: cfg.publishableKey,
      });
      ready = true;
      reason = '';
      return true;
    } catch (e) {
      reason = '云端初始化失败，已存本地';
      return false;
    }
  }

  function explain(error) {
    if (!error) return '云端没回应，已存本地';
    var code = error.code || '';
    if (code === '42P01') return '云端存档表还没建好';
    if (code === '42501') return '云端没给写入权限';
    return (error.message || '云端没回应') + '，已存本地';
  }

  async function uploadSave(spaceId, date, payload) {
    if (!ready) throw new Error(reason);
    // updated_at 只是技术时间戳，不参与任何日期判定；存档日期一律来自 YWStore.todayKey()（北京时间）
    var res = await cloud.database.from('daily_saves').upsert({
      space_id: spaceId,
      save_date: date,
      payload: payload,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'space_id,save_date' }).select();
    if (res.error) throw new Error(explain(res.error));
    return res.data;
  }

  async function listSaves(spaceId) {
    if (!ready) throw new Error(reason);
    var res = await cloud.database.from('daily_saves')
      .select('save_date, payload, updated_at')
      .eq('space_id', spaceId)
      .order('save_date', { ascending: false })
      .limit(120);
    if (res.error) throw new Error(explain(res.error));
    return res.data || [];
  }

  async function getSave(spaceId, date) {
    if (!ready) throw new Error(reason);
    var res = await cloud.database.from('daily_saves')
      .select('save_date, payload')
      .eq('space_id', spaceId)
      .eq('save_date', date)
      .maybeSingle();
    if (res.error) throw new Error(explain(res.error));
    return res.data;
  }

  window.YWCloud = {
    init: init,
    isReady: function () { return ready; },
    reason: function () { return reason; },
    uploadSave: uploadSave,
    listSaves: listSaves,
    getSave: getSave,
  };
})();
