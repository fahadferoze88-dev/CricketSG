/* Local checkpoints: acknowledge only after the IndexedDB transaction commits. */
globalThis.CricketStore = {
  async open() {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("cricket-sg-matches", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("matches", { keyPath: "id" });
        request.result.createObjectStore("meta");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Close other scorer tabs and retry."));
    });
    db.onversionchange = () => db.close();
    function transaction(stores, mode, work) {
      return new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction(stores, mode, { durability: "strict" }); }
        catch (error) {
          if (!(error instanceof TypeError)) { reject(error); return; }
          tx = db.transaction(stores, mode);
        }
        let value, failure;
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(failure || tx.error || new Error("Save interrupted"));
        try {
          work(tx, (result) => { value = result; }, (error) => { failure = error; tx.abort(); });
        } catch (error) { failure = error; tx.abort(); }
      });
    }
    return {
      close: () => db.close(),
      players: () => transaction(["meta"], "readonly", (tx, done) => {
        tx.objectStore("meta").get("players").onsuccess = (event) =>
          done(event.target.result || { players: [], pending: [], canManage: false, syncedAt: null });
      }),
      addPlayer: (player) => transaction(["meta"], "readwrite", (tx, done, fail) => {
        const meta = tx.objectStore("meta");
        meta.get("players").onsuccess = (event) => {
          const pool = event.target.result || { players: [], pending: [], canManage: false, syncedAt: null };
          if (pool.players.some((entry) => entry.id === player.id)) { fail(new Error("Player ID already exists. Retry adding the player.")); return; }
          pool.players.push({ ...player, active: true, revision: 0, mergedInto: null, reviewRequired: false, pending: true, aliases: [] });
          pool.pending.push({ id: player.id, name: player.name, nickname: player.nickname || "" });
          meta.put(pool, "players");
          done(pool);
        };
      }),
      cachePlayers: (server, acknowledgedIds = []) => transaction(["meta"], "readwrite", (tx, done) => {
        const meta = tx.objectStore("meta");
        meta.get("players").onsuccess = (event) => {
          const current = event.target.result || { players: [], pending: [] };
          const acknowledged = new Set(acknowledgedIds);
          const pending = current.pending.filter((player) => !acknowledged.has(player.id));
          const players = new Map(server.players.map((player) => [player.id, player]));
          for (const addition of pending) {
            if (!players.has(addition.id)) players.set(addition.id, current.players.find((player) => player.id === addition.id));
          }
          const pool = { players: [...players.values()], pending, canManage: server.canManage === true, syncedAt: new Date().toISOString() };
          meta.put(pool, "players");
          done(pool);
        };
      }),
      device: () => transaction(["meta"], "readwrite", (tx, done) => {
        const meta = tx.objectStore("meta");
        meta.get("device").onsuccess = (event) => {
          const id = event.target.result || crypto.randomUUID();
          meta.put(id, "device");
          done(id);
        };
      }),
      acknowledge: (id, revision, generation, finalizedRevision = null) => transaction(["matches"], "readwrite", (tx) => {
        const matches = tx.objectStore("matches");
        matches.get(id).onsuccess = (event) => {
          const record = event.target.result;
          if (record && record.generation === generation && record.revision >= revision) {
            record.syncedRevision = Math.max(record.syncedRevision, revision);
            record.finalizedRevision = finalizedRevision;
            matches.put(record);
          }
        };
      }),
      markConflict: (id, generation) => transaction(["matches"], "readwrite", (tx) => {
        const matches = tx.objectStore("matches");
        matches.get(id).onsuccess = (event) => {
          const record = event.target.result;
          if (record?.generation === generation) { record.conflicted = true; matches.put(record); }
        };
      }),
      restoreCloud: (record, expectedRevision, preserveLocal = false) => transaction(["matches", "meta"], "readwrite", (tx, done, fail) => {
        const matches = tx.objectStore("matches");
        matches.get(record.id).onsuccess = (event) => {
          const current = event.target.result;
          if ((current?.revision || 0) !== expectedRevision || (current &&
              ((!preserveLocal && current.syncedRevision !== current.revision) || current.generation > record.generation))) {
            fail(new Error("Pending device changes must be saved before cloud recovery."));
            return;
          }
          if (current && preserveLocal) {
            const copy = structuredClone(current);
            copy.id = crypto.randomUUID();
            copy.localOnly = true;
            copy.conflicted = false;
            copy.snapshot.matchConfig.matchName += " (device recovery copy)";
            matches.put(copy);
          }
          const restored = { ...record, syncedRevision: record.revision };
          matches.put(restored);
          tx.objectStore("meta").put(record.id, "active");
          done(restored);
        };
      }),
      get: (id) => transaction(["matches"], "readonly", (tx, done) => {
        tx.objectStore("matches").get(id).onsuccess = (event) => done(event.target.result);
      }),
      list: () => transaction(["matches"], "readonly", (tx, done) => {
        tx.objectStore("matches").getAll().onsuccess = (event) => done(event.target.result);
      }),
      active: () => transaction(["meta"], "readonly", (tx, done) => {
        tx.objectStore("meta").get("active").onsuccess = (event) => done(event.target.result);
      }),
      select: (id) => transaction(["meta"], "readwrite", (tx) => {
        tx.objectStore("meta").put(id, "active");
      }),
      save: (id, revision, snapshot, generation = 0, localOnly = false) => transaction(["matches", "meta"], "readwrite", (tx, done, fail) => {
        const matches = tx.objectStore("matches");
        matches.get(id).onsuccess = (event) => {
          const current = event.target.result;
          if ((current?.revision || 0) !== revision || (current?.generation || 0) !== generation) {
            const error = new Error("This match changed in another tab. Download your pending copy, then reload.");
            error.name = "RevisionConflict";
            fail(error);
            return;
          }
          const record = { id, revision: revision + 1, savedAt: new Date().toISOString(), snapshot,
            generation: current?.generation || 0, syncedRevision: current?.syncedRevision || 0,
            finalizedRevision: current?.finalizedRevision || null,
            conflicted: current?.conflicted || false, localOnly: current?.localOnly || localOnly };
          matches.put(record);
          tx.objectStore("meta").put(id, "active");
          done(record);
        };
      }),
    };
  },
};
