// ======================================================
//  loadoutStore.js - player loadout persistence
// ======================================================
//  Shared by REST endpoints and protobuf handlers.
//
//  Storage format (data/loadouts/{playerId}.json):
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
//          "loadoutSnapshot": { ... }  // optional structured JSON for Payload
//        }
//      }
//    }

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data", "loadouts");

class LoadoutStore {
    constructor() {
        this.cache = new Map();
    }

    // ---- Internal paths ----

    _playerPath(playerId) {
        const safeId = playerId.replace(/[^a-zA-Z0-9_-]/g, "_");
        return path.join(DATA_DIR, `${safeId}.json`);
    }

    _ensureDir() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
    }

    // ---- Load / save ----

    /**
     * @param {string} playerId
     * @returns {object|null}
     */
    load(playerId) {
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
     * @param {string} playerId
     * @param {object} data
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

    toFlatItemId(value, fallback = "None") {
        if (typeof value === "string") {
            return value || fallback;
        }
        if (value && typeof value === "object" && !Array.isArray(value)) {
            if (typeof value.id === "string" && value.id) return value.id;
            if (typeof value.mobilityModuleId === "string" && value.mobilityModuleId) {
                return value.mobilityModuleId;
            }
        }
        return fallback;
    }

    toFlatStringId(value, fallback = null) {
        if (typeof value !== "string") return fallback;
        return value || "None";
    }

    copyArchiveMetadata(target, source) {
        if (!source || typeof source !== "object") return;
        if (source._weaponArchiveRaw) target._weaponArchiveRaw = source._weaponArchiveRaw;
        if (source._weaponArchives && typeof source._weaponArchives === "object" && !Array.isArray(source._weaponArchives)) {
            target._weaponArchives = { ...source._weaponArchives };
        }
        if (source._skinToken) target._skinToken = source._skinToken;
        if (source._ornamentId) target._ornamentId = source._ornamentId;
        if (source._skinData) target._skinData = source._skinData;
    }

    // ---- Native protobuf shape ----

    /**
     * @param {string} playerId
     * @param {string[]} roleIds
     * @returns {object[]} PlayerRoleData array
     */
    getRoleArchive(playerId, roleIds) {
        const data = this.load(playerId);
        const roles = (data && data.roles) || {};

        return roleIds.map((roleId) => {
            const roleData = roles[roleId] || {};
            return {
                RoleID: roleId,
                LeftPylon: this.toFlatItemId(roleData.leftPylon),
                RightPylon: this.toFlatItemId(roleData.rightPylon),
                MobilityModule: this.toFlatItemId(roleData.mobilityModule),
                MeleeWeapon: this.toFlatItemId(roleData.meleeWeapon),
                PrimaryWeapon: this.toFlatItemId(roleData.primaryWeapon),
                SecondWeapon: this.toFlatItemId(roleData.secondaryWeapon),
            };
        });
    }

    /**
     * Update a single role archive from UpdateRoleArchiveV2.
     * @param {string} playerId
     * @param {string} roleId
     * @param {object} roleArchive
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

    // ---- Loadout JSON snapshots for Payload ----

    /**
     * Get a single role loadout snapshot.
     * @param {string} playerId
     * @param {string} roleId
     * @returns {object|null}
     */
    getRoleLoadoutSnapshot(playerId, roleId) {
        const data = this.load(playerId);
        if (!data || !data.roles || !data.roles[roleId]) return null;
        const roleData = data.roles[roleId];
        if (roleData.loadoutSnapshot) {
            return this.withSnapshotMetadata(roleId, roleData.loadoutSnapshot, roleData);
        }
        return this.buildFlatRoleSnapshot(roleId, roleData);
    }

    /**
     * Save a single role loadout snapshot.
     * @param {string} playerId
     * @param {string} roleId
     * @param {object} snapshot
     */
    setRoleLoadoutSnapshot(playerId, roleId, snapshot) {
        const data = this.load(playerId) || { playerId, roles: {} };

        if (!data.roles[roleId]) {
            data.roles[roleId] = {};
        }
        data.roles[roleId].loadoutSnapshot = snapshot;

        if (snapshot) {
            this.applySnapshotSummary(data.roles[roleId], snapshot);
        }

        this.save(playerId, data);
    }

    /**
     * Get all stored role loadouts for a player.
     * @param {string} playerId
     * @returns {object|null}
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
            result.roles[roleId] = roleData.loadoutSnapshot
                ? this.withSnapshotMetadata(roleId, roleData.loadoutSnapshot, roleData)
                : this.buildFlatRoleSnapshot(roleId, roleData);
        }

        return result;
    }

    normalizeFullLoadout(fullLoadout) {
        const normalized = { ...(fullLoadout || {}), roles: {} };
        const roles = fullLoadout && fullLoadout.roles;

        if (Array.isArray(roles)) {
            for (const role of roles) {
                if (!role || typeof role !== "object") continue;
                const roleId = role.roleId || role.RoleID;
                if (!roleId) continue;
                normalized.roles[roleId] = { ...role, roleId };
            }
            return normalized;
        }

        if (roles && typeof roles === "object") {
            for (const [roleId, role] of Object.entries(roles)) {
                if (!role || typeof role !== "object") continue;
                normalized.roles[roleId] = {
                    ...role,
                    roleId: role.roleId || role.RoleID || roleId,
                };
            }
        }

        return normalized;
    }

    isStructuredRoleSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== "object") return false;
        const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
        return Boolean(
            isObject(snapshot.inventory) ||
            isObject(snapshot.weaponConfigs) ||
            isObject(snapshot.characterData) ||
            isObject(snapshot.leftLauncher) ||
            isObject(snapshot.rightLauncher) ||
            isObject(snapshot.meleeWeapon) ||
            isObject(snapshot.mobilityModule)
        );
    }

    applyFlatRoleData(target, roleData) {
        const copyIfPresent = (fromKey, toKey = fromKey) => {
            if (Object.prototype.hasOwnProperty.call(roleData, fromKey)) {
                const value = this.toFlatStringId(roleData[fromKey], null);
                if (value !== null) target[toKey] = value;
            }
        };

        copyIfPresent("primaryWeapon");
        copyIfPresent("secondaryWeapon");
        copyIfPresent("leftPylon");
        copyIfPresent("leftPod", "leftPylon");
        copyIfPresent("leftLauncher", "leftPylon");
        copyIfPresent("rightPylon");
        copyIfPresent("rightPod", "rightPylon");
        copyIfPresent("rightLauncher", "rightPylon");
        copyIfPresent("mobilityModule");
        copyIfPresent("meleeWeapon");

        this.copyArchiveMetadata(target, roleData);
    }

    applySnapshotSummary(target, snapshot) {
        const wc = (snapshot && snapshot.weaponConfigs && typeof snapshot.weaponConfigs === "object")
            ? snapshot.weaponConfigs
            : {};
        const weaponIds = Object.keys(wc);
        target.primaryWeapon = weaponIds[0] || this.toFlatStringId(snapshot && snapshot.primaryWeapon, null) || target.primaryWeapon || "None";
        target.secondaryWeapon = weaponIds[1] || this.toFlatStringId(snapshot && snapshot.secondaryWeapon, null) || target.secondaryWeapon || "None";

        const leftPylon = this.toFlatItemId(snapshot && snapshot.leftLauncher, null)
            || this.toFlatStringId(snapshot && snapshot.leftPylon, null)
            || this.toFlatStringId(snapshot && snapshot.leftPod, null);
        const rightPylon = this.toFlatItemId(snapshot && snapshot.rightLauncher, null)
            || this.toFlatStringId(snapshot && snapshot.rightPylon, null)
            || this.toFlatStringId(snapshot && snapshot.rightPod, null);
        const mobilityModule = this.toFlatItemId(snapshot && snapshot.mobilityModule, null);
        const meleeWeapon = this.toFlatItemId(snapshot && snapshot.meleeWeapon, null);

        if (leftPylon !== null) target.leftPylon = leftPylon;
        if (rightPylon !== null) target.rightPylon = rightPylon;
        if (mobilityModule !== null) target.mobilityModule = mobilityModule;
        if (meleeWeapon !== null) target.meleeWeapon = meleeWeapon;

        this.copyArchiveMetadata(target, snapshot || {});
    }

    withSnapshotMetadata(roleId, snapshot, roleData) {
        const result = { ...(snapshot || {}) };
        if (!result.roleId && !result.RoleID) result.roleId = roleId;
        this.copyArchiveMetadata(result, roleData);
        return result;
    }

    buildFlatRoleSnapshot(roleId, roleData) {
        const snapshot = {
            roleId,
            primaryWeapon: this.toFlatItemId(roleData.primaryWeapon),
            secondaryWeapon: this.toFlatItemId(roleData.secondaryWeapon),
            leftPylon: this.toFlatItemId(roleData.leftPylon),
            rightPylon: this.toFlatItemId(roleData.rightPylon),
            leftPod: this.toFlatItemId(roleData.leftPylon),
            rightPod: this.toFlatItemId(roleData.rightPylon),
            leftLauncher: this.toFlatItemId(roleData.leftPylon),
            rightLauncher: this.toFlatItemId(roleData.rightPylon),
            mobilityModule: this.toFlatItemId(roleData.mobilityModule),
            meleeWeapon: this.toFlatItemId(roleData.meleeWeapon),
            _weaponArchiveRaw: roleData._weaponArchiveRaw || "",
            _weaponArchives: (roleData._weaponArchives && typeof roleData._weaponArchives === "object" && !Array.isArray(roleData._weaponArchives))
                ? { ...roleData._weaponArchives }
                : {},
            _skinToken: roleData._skinToken || "",
            _ornamentId: roleData._ornamentId || "",
        };
        if (roleData._skinData) snapshot._skinData = roleData._skinData;
        return snapshot;
    }
    /**
     * Replace or merge stored role loadouts for a player.
     * @param {string} playerId
     * @param {object} fullLoadout
     */
    setFullLoadout(playerId, fullLoadout) {
        const data = this.load(playerId) || { playerId, roles: {} };
        const normalized = this.normalizeFullLoadout(fullLoadout);

        for (const [roleId, snapshot] of Object.entries(normalized.roles || {})) {
            if (!data.roles[roleId]) {
                data.roles[roleId] = {};
            }

            if (snapshot && snapshot.loadoutSnapshot && typeof snapshot.loadoutSnapshot === "object") {
                data.roles[roleId].loadoutSnapshot = snapshot.loadoutSnapshot;
                this.applySnapshotSummary(data.roles[roleId], snapshot.loadoutSnapshot);
                this.copyArchiveMetadata(data.roles[roleId], snapshot);
            } else if (this.isStructuredRoleSnapshot(snapshot)) {
                data.roles[roleId].loadoutSnapshot = snapshot;
                this.applySnapshotSummary(data.roles[roleId], snapshot);
            } else {
                delete data.roles[roleId].loadoutSnapshot;
                this.applyFlatRoleData(data.roles[roleId], snapshot || {});
            }
        }

        this.save(playerId, data);
    }
}

// Singleton
let instance = null;

function getLoadoutStore() {
    if (!instance) {
        instance = new LoadoutStore();
    }
    return instance;
}

module.exports = { LoadoutStore, getLoadoutStore };
