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

  /* ---------- 全局礼物库（所有设备共用一份，只有家长账号能写） ----------
   * 表 gift_pool 的 RLS 规定：SELECT 所有人可读，INSERT/UPDATE/DELETE 仅允许
   * created_by = '三重刘德华' 的行。因此「谁能塞礼物」是数据库层拦的，不只是界面隐藏。
   */
  async function listGifts() {
    if (!ready) throw new Error(reason);
    var res = await cloud.database.from('gift_pool')
      .select('id, name, tier, note, created_by, created_at')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(300);
    if (res.error) throw new Error(explain(res.error));
    return res.data || [];
  }

  async function addGift(gift) {
    if (!ready) throw new Error(reason);
    var res = await cloud.database.from('gift_pool')
      .insert({ name: gift.name, tier: gift.tier, note: gift.note || '', created_by: gift.createdBy })
      .select();
    if (res.error) {
      if (res.error.code === '23505') throw new Error('这个名字已经放进礼物库了');
      if (res.error.code === '42501') throw new Error('只有礼物管理员能往库里放礼物');
      throw new Error(explain(res.error));
    }
    return (res.data || [])[0];
  }

  async function removeGift(id) {
    if (!ready) throw new Error(reason);
    var res = await cloud.database.from('gift_pool').delete().eq('id', id);
    if (res.error) throw new Error(explain(res.error));
    return true;
  }

  // 换设备已改为「输同一个昵称」自动接档，不再需要遍历云端所有存档。
  // 这里只保留按 space_id 精确查询，避免把整张表读下来。

  window.YWCloud = {
    init: init,
    isReady: function () { return ready; },
    reason: function () { return reason; },
    uploadSave: uploadSave,
    listSaves: listSaves,
    getSave: getSave,
    listGifts: listGifts,
    addGift: addGift,
    removeGift: removeGift,
  };
})();
