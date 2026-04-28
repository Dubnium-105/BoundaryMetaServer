// ======================================================
//  loadoutStore.js — 玩家配装持久化存储
// ======================================================
//  管理玩家配装数据的读写，供 REST API 和原生 protobuf
//  处理器（GetPlayerArchiveV2, UpdateRoleArchiveV2）使用。
//
//  存储格式 (data/loadouts/{playerId}.json):
//    {
//      "playerId": "...",
//      "updatedAt": "2026-04-28T...",
//      "roles": {
//        "PEACE": {
//          "primaryWeapon": "PEACE_GSW-AR",
//          "secondaryWeapon": "PEACE_RU-APS",
//          "leftPylon": "PEACE_ATK-HE",
//          "rightPylon": "None",
//          "mobilityModule": "PEACE_FCM-BOOST",
//          "meleeWeapon": "MELEE-KNIFE",
//          "loadoutSnapshot": { ... }  // 完整 loadout JSON（可选，供 Payload 使用）
//        }
//      }
//    }

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data", "loadouts");

class LoadoutStore {
    constructor() {
        // 内存缓存：playerId → loadout data
        this.cache = new Map();
    }

    // ---- 内部路径 ----

    _playerPath(playerId) {
        // 安全化 playerId（防止路径穿越）
        const safeId = playerId.replace(/[^a-zA-Z0-9_-]/g, "_");
        return path.join(DATA_DIR, `${safeId}.json`);
    }

    _ensureDir() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
    }

    // ---- 加载 / 保存 ----

    /**
     * 从磁盘加载玩家配装（含内存缓存）
     * @param {string} playerId
     * @returns {object|null} 配装数据，不存在则返回 null
     */
    load(playerId) {
        // 先查缓存
        if (this.cache.has(playerId)) {
            return this.cache.get(playerId);
        }

        const filePath = this._playerPath(playerId);
        if (!fs.existsSync(filePath)) {
            return null;
        }

        try {
            const raw = fs.readFileSync(filePath, "utf8");
            const data = JSON.parse(raw);
            this.cache.set(playerId, data);
            return data;
        } catch (e) {
            console.error(`[LoadoutStore] Failed to load loadout for ${playerId}:`, e.message);
            return null;
        }
    }

    /**
     * 保存玩家配装到磁盘并更新缓存
     * @param {string} playerId
     * @param {object} data — { roles: { roleId: { primaryWeapon, ... } } }
     */
    save(playerId, data) {
        this._ensureDir();

        const doc = {
            playerId,
            updatedAt: new Date().toISOString(),
            roles: data.roles || {},
        };

        const filePath = this._playerPath(playerId);
        try {
            fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), "utf8");
            this.cache.set(playerId, doc);
            console.log(`[LoadoutStore] Saved loadout for ${playerId}`);
        } catch (e) {
            console.error(`[LoadoutStore] Failed to save loadout for ${playerId}:`, e.message);
            throw e;
        }
    }

    // ---- 原生 protobuf 格式 ----

    /**
     * 返回 GetPlayerArchiveV2 所需格式的数据
     * @param {string} playerId
     * @param {string[]} roleIds — 请求的角色 ID 列表
     * @returns {object[]} PlayerRoleData 数组
     */
    getRoleArchive(playerId, roleIds) {
        const data = this.load(playerId);
        const roles = (data && data.roles) || {};

        return roleIds.map((roleId) => {
            const roleData = roles[roleId] || {};
            return {
                RoleID: roleId,
                LeftPylon: roleData.leftPylon || "None",
                RightPylon: roleData.rightPylon || "None",
                MobilityModule: roleData.mobilityModule || "None",
                MeleeWeapon: roleData.meleeWeapon || "None",
                PrimaryWeapon: roleData.primaryWeapon || "None",
                SecondWeapon: roleData.secondaryWeapon || "None",
            };
        });
    }

    /**
     * 更新单个角色配装（由 UpdateRoleArchiveV2 调用）
     * @param {string} playerId
     * @param {string} roleId
     * @param {object} roleArchive — { PrimaryWeapon, SecondWeapon, LeftPylon, RightPylon, MobilityModule, MeleeWeapon }
     */
    updateRoleArchive(playerId, roleId, roleArchive) {
        const data = this.load(playerId) || { playerId, roles: {} };

        data.roles[roleId] = {
            ...(data.roles[roleId] || {}),
            primaryWeapon: roleArchive.PrimaryWeapon || "None",
            secondaryWeapon: roleArchive.SecondWeapon || roleArchive.SecondaryWeapon || "None",
            leftPylon: roleArchive.LeftPylon || "None",
            rightPylon: roleArchive.RightPylon || "None",
            mobilityModule: roleArchive.MobilityModule || "None",
            meleeWeapon: roleArchive.MeleeWeapon || "None",
        };

        this.save(playerId, data);
    }

    // ---- Loadout JSON 完整快照（供 Payload 使用） ----

    /**
     * 获取指定角色的完整 loadout snapshot JSON
     * @param {string} playerId
     * @param {string} roleId
     * @returns {object|null}
     */
    getRoleLoadoutSnapshot(playerId, roleId) {
        const data = this.load(playerId);
        if (!data || !data.roles || !data.roles[roleId]) return null;
        return data.roles[roleId].loadoutSnapshot || null;
    }

    /**
     * 保存指定角色的完整 loadout snapshot JSON
     * @param {string} playerId
     * @param {string} roleId
     * @param {object} snapshot — 完整 loadout JSON（含 weaponConfigs, inventory 等）
     */
    setRoleLoadoutSnapshot(playerId, roleId, snapshot) {
        const data = this.load(playerId) || { playerId, roles: {} };

        if (!data.roles[roleId]) {
            data.roles[roleId] = {};
        }
        data.roles[roleId].loadoutSnapshot = snapshot;

        // 同时更新简化的原生格式字段
        if (snapshot) {
            const wc = snapshot.weaponConfigs || {};
            const weaponIds = Object.keys(wc);
            data.roles[roleId].primaryWeapon = weaponIds[0] || "None";
            data.roles[roleId].secondaryWeapon = weaponIds[1] || "None";
            if (snapshot.leftLauncher && snapshot.leftLauncher.id) {
                data.roles[roleId].leftPylon = snapshot.leftLauncher.id;
            }
            if (snapshot.rightLauncher && snapshot.rightLauncher.id) {
                data.roles[roleId].rightPylon = snapshot.rightLauncher.id;
            }
            if (snapshot.mobilityModule && snapshot.mobilityModule.mobilityModuleId) {
                data.roles[roleId].mobilityModule = snapshot.mobilityModule.mobilityModuleId;
            }
            if (snapshot.meleeWeapon && snapshot.meleeWeapon.id) {
                data.roles[roleId].meleeWeapon = snapshot.meleeWeapon.id;
            }
        }

        this.save(playerId, data);
    }

    /**
     * 获取玩家所有角色的完整 loadout
     * @param {string} playerId
     * @returns {object|null} — { playerId, updatedAt, roles: { roleId: loadoutSnapshot } }
     */
    getFullLoadout(playerId) {
        const data = this.load(playerId);
        if (!data) return null;

        const result = {
            playerId: data.playerId,
            updatedAt: data.updatedAt,
            roles: {},
        };

        for (const [roleId, roleData] of Object.entries(data.roles || {})) {
            result.roles[roleId] = roleData.loadoutSnapshot || roleData;
        }

        return result;
    }

    /**
     * 批量设置玩家配装（从 Browser 的完整 loadout snapshot）
     * @param {string} playerId
     * @param {object} fullLoadout — { roles: { roleId: loadoutSnapshot } }
     */
    setFullLoadout(playerId, fullLoadout) {
        const data = this.load(playerId) || { playerId, roles: {} };

        for (const [roleId, snapshot] of Object.entries(fullLoadout.roles || {})) {
            if (!data.roles[roleId]) {
                data.roles[roleId] = {};
            }
            data.roles[roleId].loadoutSnapshot = snapshot;

            // 更新简化的原生格式字段
            const wc = (snapshot && snapshot.weaponConfigs) || {};
            const weaponIds = Object.keys(wc);
            data.roles[roleId].primaryWeapon = weaponIds[0] || data.roles[roleId].primaryWeapon || "None";
            data.roles[roleId].secondaryWeapon = weaponIds[1] || data.roles[roleId].secondaryWeapon || "None";
            if (snapshot && snapshot.leftLauncher && snapshot.leftLauncher.id) {
                data.roles[roleId].leftPylon = snapshot.leftLauncher.id;
            }
            if (snapshot && snapshot.rightLauncher && snapshot.rightLauncher.id) {
                data.roles[roleId].rightPylon = snapshot.rightLauncher.id;
            }
            if (snapshot && snapshot.mobilityModule && snapshot.mobilityModule.mobilityModuleId) {
                data.roles[roleId].mobilityModule = snapshot.mobilityModule.mobilityModuleId;
            }
            if (snapshot && snapshot.meleeWeapon && snapshot.meleeWeapon.id) {
                data.roles[roleId].meleeWeapon = snapshot.meleeWeapon.id;
            }
        }

        this.save(playerId, data);
    }
}

// 单例
let instance = null;

function getLoadoutStore() {
    if (!instance) {
        instance = new LoadoutStore();
    }
    return instance;
}

module.exports = { LoadoutStore, getLoadoutStore };
