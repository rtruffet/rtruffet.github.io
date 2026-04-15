(function () {
  const forceServerMode = new URL(window.location.href).searchParams.get("server") === "1";
  if (forceServerMode) return;

  const API_ORIGIN = "http://localhost:8000";
  const DB_KEY = "corrigator.local.db.v1";
  const CLOUD_KEY = "corrigator.local.cloud.v1";
  const META_KEY = "corrigator.local.meta.v1";

  const nativeFetch = window.fetch.bind(window);

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function defaultDb() {
    return {
      seq: {
        groupes: 1,
        etudiants: 1,
        devoirs: 1,
        devoir_groupes: 1,
        exercices: 1,
        questions: 1,
        notes: 1,
        ajustements_notes: 1,
      },
      groupes: [],
      etudiants: [],
      devoirs: [],
      devoir_groupes: [],
      exercices: [],
      questions: [],
      notes: [],
      ajustements_notes: [],
    };
  }

  function nowMs() {
    return Date.now();
  }

  function loadDb() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (!raw) return defaultDb();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultDb(), parsed);
    } catch (_err) {
      return defaultDb();
    }
  }

  function getMeta() {
    try {
      const raw = localStorage.getItem(META_KEY);
      if (!raw) {
        return { localMtimeMs: nowMs() };
      }
      const parsed = JSON.parse(raw);
      if (!parsed.localMtimeMs) parsed.localMtimeMs = nowMs();
      return parsed;
    } catch (_err) {
      return { localMtimeMs: nowMs() };
    }
  }

  let db = loadDb();
  let meta = getMeta();

  function updateLocalMeta() {
    meta.localMtimeMs = nowMs();
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  }

  function saveDb() {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    updateLocalMeta();
  }

  function makeMetaEntry(name, payload, mtimeMs) {
    if (!payload) return null;
    const size = new TextEncoder().encode(JSON.stringify(payload)).length;
    return {
      path: name,
      size,
      mtimeMs,
      mtimeIso: new Date(mtimeMs).toISOString(),
    };
  }

  function getCloudSnapshot() {
    try {
      const raw = localStorage.getItem(CLOUD_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.db || !parsed.mtimeMs) return null;
      return parsed;
    } catch (_err) {
      return null;
    }
  }

  function setCloudSnapshot(snapshotDb) {
    const snap = {
      db: deepClone(snapshotDb),
      mtimeMs: nowMs(),
    };
    localStorage.setItem(CLOUD_KEY, JSON.stringify(snap));
  }

  function nextId(tableName) {
    const id = Number(db.seq[tableName] || 1);
    db.seq[tableName] = id + 1;
    return id;
  }

  function toInt(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.trunc(n);
  }

  function toNum(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return n;
  }

  function byOrderThenId(a, b) {
    const ao = Number(a.ordre || 0);
    const bo = Number(b.ordre || 0);
    if (ao !== bo) return ao - bo;
    return Number(a.id) - Number(b.id);
  }

  function groupNameById(groupeId) {
    const g = db.groupes.find((x) => x.id === groupeId);
    return g ? g.nom : null;
  }

  function clampNote20(value) {
    return Math.max(0, Math.min(20, value));
  }

  function buildDevoirById(devoirId) {
    const devoir = db.devoirs.find((d) => d.id === devoirId);
    if (!devoir) return null;

    const exos = db.exercices
      .filter((e) => e.devoir_id === devoirId)
      .sort(byOrderThenId)
      .map((e) => {
        const questions = db.questions
          .filter((q) => q.exercice_id === e.id)
          .sort(byOrderThenId)
          .map((q) => ({
            id: q.id,
            exercice_id: q.exercice_id,
            enonce: q.enonce,
            poids: Number(q.poids || 0),
            ordre: Number(q.ordre || 0),
          }));
        return {
          id: e.id,
          devoir_id: e.devoir_id,
          titre: e.titre,
          ordre: Number(e.ordre || 0),
          questions,
        };
      });

    const groupes = db.devoir_groupes
      .filter((dg) => dg.devoir_id === devoirId)
      .map((dg) => ({
        id: dg.groupe_id,
        nom: groupNameById(dg.groupe_id) || "",
        rehausse_pct: Number(dg.rehausse_pct || 0),
      }))
      .sort((a, b) => a.nom.localeCompare(b.nom, "fr", { sensitivity: "base" }));

    return {
      id: devoir.id,
      titre: devoir.titre,
      description: devoir.description,
      exercices: exos,
      groupes,
    };
  }

  function getEtudiantsDevoir(devoirId, groupeId, recherche) {
    const groupIds = db.devoir_groupes
      .filter((dg) => dg.devoir_id === devoirId)
      .map((dg) => dg.groupe_id);
    if (!groupIds.length) return [];

    const groupSet = new Set(groupIds);
    const txt = recherche ? String(recherche).toLowerCase() : null;

    return db.etudiants
      .filter((e) => groupSet.has(e.groupe_id))
      .filter((e) => (groupeId == null ? true : e.groupe_id === groupeId))
      .filter((e) => {
        if (!txt) return true;
        return String(e.nom).toLowerCase().includes(txt) || String(e.prenom).toLowerCase().includes(txt);
      })
      .sort((a, b) => {
        const c = a.nom.localeCompare(b.nom, "fr", { sensitivity: "base" });
        if (c !== 0) return c;
        return a.prenom.localeCompare(b.prenom, "fr", { sensitivity: "base" });
      })
      .map((e) => ({
        id: e.id,
        nom: e.nom,
        prenom: e.prenom,
        email: e.email,
        groupe_id: e.groupe_id,
        groupe_nom: groupNameById(e.groupe_id),
      }));
  }

  function getQuestionIdsForDevoir(devoirId) {
    const exIds = db.exercices.filter((e) => e.devoir_id === devoirId).map((e) => e.id);
    const exSet = new Set(exIds);
    return db.questions.filter((q) => exSet.has(q.exercice_id)).map((q) => q.id);
  }

  function getNotesEtudiantDevoir(etudiantId, devoirId) {
    const qSet = new Set(getQuestionIdsForDevoir(devoirId));
    return db.notes
      .filter((n) => n.etudiant_id === etudiantId && qSet.has(n.question_id))
      .map((n) => ({ question_id: n.question_id, valeur: n.valeur, commentaire: n.commentaire || null }));
  }

  function getResultatsDevoir(devoirId, groupeId) {
    const devoir = buildDevoirById(devoirId);
    if (!devoir || !devoir.groupes.length) return [];

    const etudiants = getEtudiantsDevoir(devoirId, groupeId, null);
    const questions = devoir.exercices.flatMap((ex) => ex.questions);
    const questionPoids = new Map(questions.map((q) => [q.id, Number(q.poids || 0)]));
    const poidsTotal = questions.reduce((acc, q) => acc + Number(q.poids || 0), 0);

    const ajustements = new Map(
      db.ajustements_notes
        .filter((a) => a.devoir_id === devoirId)
        .map((a) => [a.etudiant_id, a])
    );
    const rehausses = new Map(
      db.devoir_groupes
        .filter((dg) => dg.devoir_id === devoirId)
        .map((dg) => [dg.groupe_id, Number(dg.rehausse_pct || 0)])
    );

    const resultats = etudiants.map((e) => {
      const notes = getNotesEtudiantDevoir(e.id, devoirId);
      const notesMap = new Map(notes.map((n) => [n.question_id, n.valeur]));

      const noteTotale = Array.from(questionPoids.entries()).reduce((acc, entry) => {
        const qid = entry[0];
        const poids = entry[1];
        const v = notesMap.get(qid);
        return acc + (Number(v || 0) * poids);
      }, 0);

      const base20 = poidsTotal > 0 ? (noteTotale / poidsTotal) * 20 : 0;
      const aj = ajustements.get(e.id);
      const bonusAbs = Number(aj ? aj.bonus_abs : 0) || 0;
      const bonusPct = Number(aj ? aj.bonus_pct : 0) || 0;
      const rehausseGroupePct = Number(rehausses.get(e.groupe_id) || 0);
      const noteAvantRehausse = base20 * (1 + bonusPct / 100) + bonusAbs;
      const noteSur20 = clampNote20(noteAvantRehausse * (1 + rehausseGroupePct / 100));

      return {
        etudiant: {
          id: e.id,
          nom: e.nom,
          prenom: e.prenom,
          email: e.email,
        },
        note_totale: Number(noteTotale.toFixed(3)),
        poids_total: Number(poidsTotal.toFixed(3)),
        note_sur_20: Number(noteSur20.toFixed(3)),
        bonus_abs: Number(bonusAbs.toFixed(3)),
        bonus_pct: Number(bonusPct.toFixed(3)),
        rehausse_groupe_pct: Number(rehausseGroupePct.toFixed(3)),
        classement_groupe: null,
        nb_corrigees_groupe: 0,
        groupe_nom: e.groupe_nom,
        copie_corrigee: notes.length > 0,
        notes,
        _groupe_id: e.groupe_id,
        _nom: e.nom,
        _prenom: e.prenom,
      };
    });

    const corrigeesParGroupe = new Map();
    for (const r of resultats) {
      if (!r.copie_corrigee || !r._groupe_id) continue;
      if (!corrigeesParGroupe.has(r._groupe_id)) corrigeesParGroupe.set(r._groupe_id, []);
      corrigeesParGroupe.get(r._groupe_id).push(r);
    }

    for (const rows of corrigeesParGroupe.values()) {
      rows.sort((a, b) => {
        if (b.note_sur_20 !== a.note_sur_20) return b.note_sur_20 - a.note_sur_20;
        const nc = a._nom.localeCompare(b._nom, "fr", { sensitivity: "base" });
        if (nc !== 0) return nc;
        return a._prenom.localeCompare(b._prenom, "fr", { sensitivity: "base" });
      });

      let rang = 0;
      let lastNote = null;
      rows.forEach((r, i) => {
        if (lastNote === null || r.note_sur_20 !== lastNote) {
          rang = i + 1;
          lastNote = r.note_sur_20;
        }
        r.classement_groupe = rang;
        r.nb_corrigees_groupe = rows.length;
      });
    }

    return resultats.map((r) => {
      delete r._groupe_id;
      delete r._nom;
      delete r._prenom;
      return r;
    });
  }

  function parseMailConfig(input) {
    const cfg = input || {};
    return {
      include_note_brute: cfg.include_note_brute !== false,
      include_note_sur_20: cfg.include_note_sur_20 !== false,
      include_ajustements: cfg.include_ajustements !== false,
      include_classement: cfg.include_classement !== false,
      include_detail_correction: cfg.include_detail_correction !== false,
      texte_libre_1: String(cfg.texte_libre_1 || ""),
      texte_libre_2: String(cfg.texte_libre_2 || ""),
      signature: String(cfg.signature || "Votre enseignant"),
    };
  }

  function buildMailTemplates(devoir, resultats, config) {
    return resultats.map((r) => {
      const etudiant = r.etudiant;
      const rangTxt =
        r.classement_groupe != null && r.nb_corrigees_groupe > 0
          ? `${r.classement_groupe}/${r.nb_corrigees_groupe}`
          : "Non classe (copie non corrigee)";

      const notesMap = new Map((r.notes || []).map((n) => [n.question_id, n]));
      const detailLines = [];

      if (config.include_detail_correction) {
        const exos = deepClone(devoir.exercices).sort(byOrderThenId);
        for (const ex of exos) {
          const exoLines = [ex.titre];
          const qs = deepClone(ex.questions).sort(byOrderThenId);
          qs.forEach((q, idx) => {
            const noteObj = notesMap.get(q.id);
            const valeur = noteObj && noteObj.valeur != null ? Number(noteObj.valeur) : 0;
            const points = Number((valeur * Number(q.poids || 0)).toFixed(3));
            const commentaire = String((noteObj && noteObj.commentaire) || "").trim();
            const qName = String(q.enonce || "").trim() || `Question ${Number(q.ordre || 0) + 1}`;
            const branch = idx === qs.length - 1 ? "└" : "├";
            const commentBranch = branch === "└" ? "  " : "│ ";
            let line = `  ${branch} ${qName} : ${points}/${q.poids} pts`;
            if (commentaire) line += `\n  ${commentBranch} └ Remarque : ${commentaire}`;
            exoLines.push(line);
          });
          if (exoLines.length === 1) exoLines.push("  └ (Aucune question)");
          detailLines.push(exoLines.join("\n"));
        }
      }

      const lines = [
        `Bonjour ${etudiant.prenom},`,
        "",
        `Voici votre resultat pour « ${devoir.titre} » :`,
      ];

      if (String(config.texte_libre_1 || "").trim()) {
        lines.push("", String(config.texte_libre_1).trim());
      }

      if (config.include_note_brute) lines.push(`Note brute : ${r.note_totale} / ${r.poids_total}`);
      if (config.include_note_sur_20) lines.push(`Note finale sur 20 : ${r.note_sur_20}/20`);
      if (config.include_ajustements) {
        lines.push(
          `Ajustements : individuel ${r.bonus_abs >= 0 ? "+" : ""}${r.bonus_abs.toFixed(2)} point(s), individuel ${r.bonus_pct >= 0 ? "+" : ""}${r.bonus_pct.toFixed(2)}%, groupe ${r.rehausse_groupe_pct >= 0 ? "+" : ""}${r.rehausse_groupe_pct.toFixed(2)}%`
        );
      }
      if (config.include_classement) lines.push(`Classement dans le groupe (copies corrigees) : ${rangTxt}`);

      if (config.include_detail_correction) {
        lines.push("", "Detail de la correction :", detailLines.length ? detailLines.join("\n\n") : "(Aucune question dans ce devoir)");
      }

      if (String(config.texte_libre_2 || "").trim()) {
        lines.push("", String(config.texte_libre_2).trim());
      }

      lines.push("", "Cordialement,", String(config.signature || "").trim() || "Votre enseignant");

      return {
        to: etudiant.email || "(pas d'email)",
        subject: `Resultats - ${devoir.titre}`,
        body: lines.join("\n"),
        classement_groupe: r.classement_groupe,
        nb_corrigees_groupe: r.nb_corrigees_groupe,
      };
    });
  }

  function parseImportRows(contenu, separateur, entete) {
    const lines = String(contenu || "")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    const rows = lines.map((line) => line.split(separateur));
    return entete ? rows.slice(1) : rows;
  }

  function getRelation(local, cloud) {
    if (!local && !cloud) return "both-missing";
    if (local && !cloud) return "missing-cloud";
    if (!local && cloud) return "missing-local";
    if (Math.abs(local.mtimeMs - cloud.mtimeMs) < 1) return "in-sync";
    return local.mtimeMs > cloud.mtimeMs ? "local-newer" : "cloud-newer";
  }

  function jsonResponse(status, data, extraHeaders) {
    const headers = Object.assign({ "Content-Type": "application/json" }, extraHeaders || {});
    return new Response(JSON.stringify(data), { status, headers });
  }

  function emptyResponse(status) {
    return new Response(null, { status });
  }

  function textResponse(status, body, contentType, extraHeaders) {
    const headers = Object.assign({ "Content-Type": contentType || "text/plain" }, extraHeaders || {});
    return new Response(body, { status, headers });
  }

  async function requestJson(req) {
    const ct = (req.headers.get("Content-Type") || "").toLowerCase();
    if (!ct.includes("application/json")) return {};
    try {
      return await req.json();
    } catch (_err) {
      return {};
    }
  }

  function mustExist(table, id, detail) {
    const row = db[table].find((x) => x.id === id);
    if (!row) return { error: jsonResponse(404, { detail }) };
    return { row };
  }

  function deleteQuestionCascade(questionId) {
    db.questions = db.questions.filter((q) => q.id !== questionId);
    db.notes = db.notes.filter((n) => n.question_id !== questionId);
  }

  function deleteExerciceCascade(exerciceId) {
    const qIds = db.questions.filter((q) => q.exercice_id === exerciceId).map((q) => q.id);
    const qSet = new Set(qIds);
    db.exercices = db.exercices.filter((e) => e.id !== exerciceId);
    db.questions = db.questions.filter((q) => !qSet.has(q.id));
    db.notes = db.notes.filter((n) => !qSet.has(n.question_id));
  }

  function deleteDevoirCascade(devoirId) {
    const exIds = db.exercices.filter((e) => e.devoir_id === devoirId).map((e) => e.id);
    const exSet = new Set(exIds);
    const qIds = db.questions.filter((q) => exSet.has(q.exercice_id)).map((q) => q.id);
    const qSet = new Set(qIds);

    db.devoirs = db.devoirs.filter((d) => d.id !== devoirId);
    db.devoir_groupes = db.devoir_groupes.filter((dg) => dg.devoir_id !== devoirId);
    db.ajustements_notes = db.ajustements_notes.filter((a) => a.devoir_id !== devoirId);
    db.exercices = db.exercices.filter((e) => !exSet.has(e.id));
    db.questions = db.questions.filter((q) => !qSet.has(q.id));
    db.notes = db.notes.filter((n) => !qSet.has(n.question_id));
  }

  function parsePath(pathname) {
    return pathname.replace(/\/+$/, "") || "/";
  }

  async function handleApi(req, url) {
    const method = req.method.toUpperCase();
    const path = parsePath(url.pathname);

    if (method === "GET" && path === "/docs") {
      return jsonResponse(200, { message: "Corrigator offline actif (PWA)." });
    }

    if (method === "GET" && path === "/sync/status") {
      const local = makeMetaEntry("browser://local-db", db, Number(meta.localMtimeMs || nowMs()));
      const cloudSnap = getCloudSnapshot();
      const cloud = cloudSnap ? makeMetaEntry("browser://cloud-snapshot", cloudSnap.db, cloudSnap.mtimeMs) : null;
      return jsonResponse(200, {
        local,
        cloud,
        relation: getRelation(local, cloud),
        sync_in_progress: false,
        cloud_path: "browser://cloud-snapshot",
      });
    }

    if (method === "POST" && path === "/sync/push") {
      const payload = await requestJson(req);
      const force = url.searchParams.get("force") === "1" || Boolean(payload.force);
      const local = makeMetaEntry("browser://local-db", db, Number(meta.localMtimeMs || nowMs()));
      const cloudSnap = getCloudSnapshot();
      const cloud = cloudSnap ? makeMetaEntry("browser://cloud-snapshot", cloudSnap.db, cloudSnap.mtimeMs) : null;

      if (local && cloud && local.mtimeMs < cloud.mtimeMs && !force) {
        return jsonResponse(409, {
          code: "STALE_PUSH",
          detail: "La base cloud est plus recente. Push bloque pour eviter un ecrasement.",
          require_force: true,
          local,
          cloud,
        });
      }

      setCloudSnapshot(db);
      const newCloudSnap = getCloudSnapshot();
      const newCloud = newCloudSnap ? makeMetaEntry("browser://cloud-snapshot", newCloudSnap.db, newCloudSnap.mtimeMs) : null;
      return jsonResponse(200, { ok: true, action: "push", local, cloud: newCloud, cloud_path: "browser://cloud-snapshot" });
    }

    if (method === "POST" && path === "/sync/pull") {
      const payload = await requestJson(req);
      const force = url.searchParams.get("force") === "1" || Boolean(payload.force);
      const local = makeMetaEntry("browser://local-db", db, Number(meta.localMtimeMs || nowMs()));
      const cloudSnap = getCloudSnapshot();
      const cloud = cloudSnap ? makeMetaEntry("browser://cloud-snapshot", cloudSnap.db, cloudSnap.mtimeMs) : null;
      if (!cloudSnap) {
        return jsonResponse(404, { detail: "Base cloud introuvable" });
      }

      if (local && cloud && cloud.mtimeMs < local.mtimeMs && !force) {
        return jsonResponse(409, {
          code: "STALE_PULL",
          detail: "La base locale est plus recente. Pull bloque pour eviter un ecrasement.",
          require_force: true,
          local,
          cloud,
        });
      }

      db = deepClone(cloudSnap.db);
      saveDb();
      const updatedLocal = makeMetaEntry("browser://local-db", db, Number(meta.localMtimeMs || nowMs()));
      return jsonResponse(200, { ok: true, action: "pull", local: updatedLocal, cloud, cloud_path: "browser://cloud-snapshot" });
    }

    if (method === "GET" && path === "/groupes") {
      const rows = db.groupes
        .map((g) => ({
          id: g.id,
          nom: g.nom,
          nb_etudiants: db.etudiants.filter((e) => e.groupe_id === g.id).length,
        }))
        .sort((a, b) => a.nom.localeCompare(b.nom, "fr", { sensitivity: "base" }));
      return jsonResponse(200, rows);
    }

    if (method === "POST" && path === "/groupes") {
      const body = await requestJson(req);
      const nom = String(body.nom || "").trim();
      if (!nom) return jsonResponse(422, { detail: "Nom requis" });
      const exists = db.groupes.some((g) => g.nom.toLowerCase() === nom.toLowerCase());
      if (exists) return jsonResponse(400, { detail: "Nom de groupe deja utilise" });
      const created = { id: nextId("groupes"), nom };
      db.groupes.push(created);
      saveDb();
      return jsonResponse(201, { id: created.id, nom: created.nom, nb_etudiants: 0 });
    }

    {
      const m = path.match(/^\/groupes\/(\d+)$/);
      if (m && method === "DELETE") {
        const groupeId = toInt(m[1], 0);
        const idx = db.groupes.findIndex((g) => g.id === groupeId);
        if (idx < 0) return jsonResponse(404, { detail: "Groupe introuvable" });
        db.groupes.splice(idx, 1);
        db.devoir_groupes = db.devoir_groupes.filter((dg) => dg.groupe_id !== groupeId);
        db.etudiants = db.etudiants.map((e) => (e.groupe_id === groupeId ? Object.assign({}, e, { groupe_id: null }) : e));
        saveDb();
        return emptyResponse(204);
      }
    }

    {
      const m = path.match(/^\/groupes\/(\d+)\/import-etudiants$/);
      if (m && method === "POST") {
        const groupeId = toInt(m[1], 0);
        const exists = db.groupes.some((g) => g.id === groupeId);
        if (!exists) return jsonResponse(404, { detail: "Groupe introuvable" });

        const body = await requestJson(req);
        const separateur = body.separateur || ";";
        const entete = Boolean(body.entete);
        const rows = parseImportRows(body.contenu || "", separateur, entete);

        let crees = 0;
        let ignores = 0;
        const erreurs = [];
        rows.forEach((row, idx) => {
          const lineNo = entete ? idx + 2 : idx + 1;
          if (!row || row.every((c) => !String(c || "").trim())) {
            ignores += 1;
            return;
          }
          if (row.length < 2) {
            erreurs.push(`Ligne ${lineNo}: au moins prenom et nom requis`);
            return;
          }
          const prenom = String(row[0] || "").trim();
          const nom = String(row[1] || "").trim();
          const email = String(row[2] || "").trim() || null;
          if (!prenom || !nom) {
            erreurs.push(`Ligne ${lineNo}: prenom/nom vides`);
            return;
          }
          db.etudiants.push({
            id: nextId("etudiants"),
            nom,
            prenom,
            email,
            groupe_id: groupeId,
          });
          crees += 1;
        });
        saveDb();
        return jsonResponse(200, { crees, ignores, erreurs });
      }
    }

    if (method === "GET" && path === "/etudiants") {
      const groupeId = url.searchParams.get("groupe_id");
      const gid = groupeId != null && groupeId !== "" ? toInt(groupeId, null) : null;
      const rows = db.etudiants
        .filter((e) => (gid == null ? true : e.groupe_id === gid))
        .sort((a, b) => {
          const c = a.nom.localeCompare(b.nom, "fr", { sensitivity: "base" });
          if (c !== 0) return c;
          return a.prenom.localeCompare(b.prenom, "fr", { sensitivity: "base" });
        })
        .map((e) => ({
          id: e.id,
          nom: e.nom,
          prenom: e.prenom,
          email: e.email,
          groupe_id: e.groupe_id,
          groupe_nom: groupNameById(e.groupe_id),
        }));
      return jsonResponse(200, rows);
    }

    if (method === "POST" && path === "/etudiants") {
      const body = await requestJson(req);
      const nom = String(body.nom || "").trim();
      const prenom = String(body.prenom || "").trim();
      const email = body.email == null ? null : String(body.email).trim() || null;
      const groupeId = body.groupe_id == null ? null : toInt(body.groupe_id, null);
      if (!nom || !prenom) return jsonResponse(422, { detail: "Nom et prenom requis" });

      const created = {
        id: nextId("etudiants"),
        nom,
        prenom,
        email,
        groupe_id: groupeId,
      };
      db.etudiants.push(created);
      saveDb();
      return jsonResponse(201, {
        id: created.id,
        nom: created.nom,
        prenom: created.prenom,
        email: created.email,
        groupe_id: created.groupe_id,
        groupe_nom: groupNameById(created.groupe_id),
      });
    }

    {
      const m = path.match(/^\/etudiants\/(\d+)$/);
      if (m && method === "DELETE") {
        const etudiantId = toInt(m[1], 0);
        const idx = db.etudiants.findIndex((e) => e.id === etudiantId);
        if (idx < 0) return jsonResponse(404, { detail: "Etudiant introuvable" });
        db.etudiants.splice(idx, 1);
        db.notes = db.notes.filter((n) => n.etudiant_id !== etudiantId);
        db.ajustements_notes = db.ajustements_notes.filter((a) => a.etudiant_id !== etudiantId);
        saveDb();
        return emptyResponse(204);
      }
    }

    if (method === "GET" && path === "/devoirs") {
      const rows = deepClone(db.devoirs).sort((a, b) => a.id - b.id);
      return jsonResponse(200, rows);
    }

    if (method === "POST" && path === "/devoirs") {
      const body = await requestJson(req);
      const titre = String(body.titre || "").trim();
      const description = body.description == null ? null : String(body.description);
      if (!titre) return jsonResponse(422, { detail: "Titre requis" });
      const created = { id: nextId("devoirs"), titre, description };
      db.devoirs.push(created);
      saveDb();
      return jsonResponse(201, buildDevoirById(created.id));
    }

    {
      const m = path.match(/^\/devoirs\/(\d+)$/);
      if (m && method === "GET") {
        const devoirId = toInt(m[1], 0);
        const devoir = buildDevoirById(devoirId);
        if (!devoir) return jsonResponse(404, { detail: "Devoir introuvable" });
        return jsonResponse(200, devoir);
      }
      if (m && method === "DELETE") {
        const devoirId = toInt(m[1], 0);
        const exists = db.devoirs.some((d) => d.id === devoirId);
        if (!exists) return jsonResponse(404, { detail: "Devoir introuvable" });
        deleteDevoirCascade(devoirId);
        saveDb();
        return emptyResponse(204);
      }
    }

    {
      const m = path.match(/^\/devoirs\/(\d+)\/groupes$/);
      if (m && method === "GET") {
        const devoirId = toInt(m[1], 0);
        const devoir = db.devoirs.find((d) => d.id === devoirId);
        if (!devoir) return jsonResponse(404, { detail: "Devoir introuvable" });
        const rows = db.devoir_groupes
          .filter((dg) => dg.devoir_id === devoirId)
          .map((dg) => ({
            id: dg.groupe_id,
            nom: groupNameById(dg.groupe_id) || "",
            rehausse_pct: Number(dg.rehausse_pct || 0),
          }))
          .sort((a, b) => a.nom.localeCompare(b.nom, "fr", { sensitivity: "base" }));
        return jsonResponse(200, rows);
      }
    }

    {
      const m = path.match(/^\/devoirs\/(\d+)\/groupes\/(\d+)$/);
      if (m && method === "POST") {
        const devoirId = toInt(m[1], 0);
        const groupeId = toInt(m[2], 0);
        const devoir = db.devoirs.find((d) => d.id === devoirId);
        const groupe = db.groupes.find((g) => g.id === groupeId);
        if (!devoir || !groupe) return jsonResponse(404, { detail: "Devoir ou groupe introuvable" });
        const exists = db.devoir_groupes.some((dg) => dg.devoir_id === devoirId && dg.groupe_id === groupeId);
        if (!exists) {
          db.devoir_groupes.push({
            id: nextId("devoir_groupes"),
            devoir_id: devoirId,
            groupe_id: groupeId,
            rehausse_pct: 0,
          });
          saveDb();
        }
        return emptyResponse(204);
      }
      if (m && method === "DELETE") {
        const devoirId = toInt(m[1], 0);
        const groupeId = toInt(m[2], 0);
        const devoir = db.devoirs.find((d) => d.id === devoirId);
        if (!devoir) return jsonResponse(404, { detail: "Devoir introuvable" });
        db.devoir_groupes = db.devoir_groupes.filter((dg) => !(dg.devoir_id === devoirId && dg.groupe_id === groupeId));
        saveDb();
        return emptyResponse(204);
      }
    }

    {
      const m = path.match(/^\/devoirs\/(\d+)\/groupes\/(\d+)\/rehausse$/);
      if (m && method === "POST") {
        const devoirId = toInt(m[1], 0);
        const groupeId = toInt(m[2], 0);
        const body = await requestJson(req);
        const bonusPct = toNum(body.bonus_pct, 0);
        const row = db.devoir_groupes.find((dg) => dg.devoir_id === devoirId && dg.groupe_id === groupeId);
        if (!row) return jsonResponse(404, { detail: "Association devoir/groupe introuvable" });
        row.rehausse_pct = bonusPct;
        saveDb();
        return jsonResponse(200, { groupe_id: groupeId, rehausse_pct: bonusPct });
      }
    }

    {
      const m = path.match(/^\/devoirs\/(\d+)\/ajustements\/(\d+)$/);
      if (m && method === "PUT") {
        const devoirId = toInt(m[1], 0);
        const etudiantId = toInt(m[2], 0);
        const body = await requestJson(req);
        const bonusAbs = toNum(body.bonus_abs, 0);
        const bonusPct = toNum(body.bonus_pct, 0);

        const devoir = db.devoirs.find((d) => d.id === devoirId);
        const etudiant = db.etudiants.find((e) => e.id === etudiantId);
        if (!devoir) return jsonResponse(404, { detail: "Devoir introuvable" });
        if (!etudiant) return jsonResponse(404, { detail: "Etudiant introuvable" });

        let row = db.ajustements_notes.find((a) => a.devoir_id === devoirId && a.etudiant_id === etudiantId);
        if (!row) {
          row = {
            id: nextId("ajustements_notes"),
            devoir_id: devoirId,
            etudiant_id: etudiantId,
            bonus_abs: bonusAbs,
            bonus_pct: bonusPct,
          };
          db.ajustements_notes.push(row);
        } else {
          row.bonus_abs = bonusAbs;
          row.bonus_pct = bonusPct;
        }
        saveDb();
        return emptyResponse(204);
      }
    }

    {
      const m = path.match(/^\/devoirs\/(\d+)\/etudiants$/);
      if (m && method === "GET") {
        const devoirId = toInt(m[1], 0);
        const groupeId = url.searchParams.get("groupe_id");
        const recherche = url.searchParams.get("recherche");
        const gid = groupeId == null || groupeId === "" ? null : toInt(groupeId, null);
        const rows = getEtudiantsDevoir(devoirId, gid, recherche);
        return jsonResponse(200, rows);
      }
    }

    {
      const m = path.match(/^\/devoirs\/(\d+)\/exercices$/);
      if (m && method === "POST") {
        const devoirId = toInt(m[1], 0);
        const body = await requestJson(req);
        const titre = String(body.titre || "").trim();
        const ordre = toNum(body.ordre, 0);
        const devoir = db.devoirs.find((d) => d.id === devoirId);
        if (!devoir) return jsonResponse(404, { detail: "Devoir introuvable" });
        if (!titre) return jsonResponse(422, { detail: "Titre requis" });

        const created = {
          id: nextId("exercices"),
          devoir_id: devoirId,
          titre,
          ordre,
        };
        db.exercices.push(created);
        saveDb();
        return jsonResponse(201, Object.assign({}, created, { questions: [] }));
      }
    }

    {
      const m = path.match(/^\/exercices\/(\d+)$/);
      if (m && method === "DELETE") {
        const exerciceId = toInt(m[1], 0);
        const ex = db.exercices.find((e) => e.id === exerciceId);
        if (!ex) return jsonResponse(404, { detail: "Exercice introuvable" });
        deleteExerciceCascade(exerciceId);
        saveDb();
        return emptyResponse(204);
      }
    }

    {
      const m = path.match(/^\/exercices\/(\d+)\/move$/);
      if (m && method === "POST") {
        const exerciceId = toInt(m[1], 0);
        const body = await requestJson(req);
        const direction = toNum(body.direction, 1);
        const ex = db.exercices.find((e) => e.id === exerciceId);
        if (!ex) return jsonResponse(404, { detail: "Impossible de deplacer l'exercice" });

        const rows = db.exercices.filter((e) => e.devoir_id === ex.devoir_id).sort(byOrderThenId);
        const idx = rows.findIndex((r) => r.id === exerciceId);
        if (idx < 0) return jsonResponse(404, { detail: "Impossible de deplacer l'exercice" });
        const voisin = direction < 0 ? rows[idx - 1] : rows[idx + 1];
        if (!voisin) return jsonResponse(404, { detail: "Impossible de deplacer l'exercice" });

        const old = ex.ordre;
        ex.ordre = voisin.ordre;
        voisin.ordre = old;
        saveDb();
        return jsonResponse(200, { success: true });
      }
    }

    {
      const m = path.match(/^\/exercices\/(\d+)\/questions$/);
      if (m && method === "POST") {
        const exerciceId = toInt(m[1], 0);
        const body = await requestJson(req);
        const enonce = String(body.enonce || "").trim();
        const poids = toNum(body.poids, 1);
        const ordre = toNum(body.ordre, 0);
        const ex = db.exercices.find((e) => e.id === exerciceId);
        if (!ex) return jsonResponse(404, { detail: "Exercice introuvable" });
        if (!enonce) return jsonResponse(422, { detail: "Enonce requis" });

        const created = {
          id: nextId("questions"),
          exercice_id: exerciceId,
          enonce,
          poids,
          ordre,
        };
        db.questions.push(created);
        saveDb();
        return jsonResponse(201, created);
      }
    }

    {
      const m = path.match(/^\/questions\/(\d+)$/);
      if (m && method === "PATCH") {
        const questionId = toInt(m[1], 0);
        const q = db.questions.find((x) => x.id === questionId);
        if (!q) return jsonResponse(404, { detail: "Question introuvable" });
        const body = await requestJson(req);
        if (Object.prototype.hasOwnProperty.call(body, "enonce")) q.enonce = String(body.enonce);
        if (Object.prototype.hasOwnProperty.call(body, "poids")) q.poids = toNum(body.poids, q.poids);
        saveDb();
        return jsonResponse(200, deepClone(q));
      }
      if (m && method === "DELETE") {
        const questionId = toInt(m[1], 0);
        const exists = db.questions.some((q) => q.id === questionId);
        if (!exists) return jsonResponse(404, { detail: "Question introuvable" });
        deleteQuestionCascade(questionId);
        saveDb();
        return emptyResponse(204);
      }
    }

    {
      const m = path.match(/^\/questions\/(\d+)\/move$/);
      if (m && method === "POST") {
        const questionId = toInt(m[1], 0);
        const body = await requestJson(req);
        const direction = toNum(body.direction, 1);
        const q = db.questions.find((x) => x.id === questionId);
        if (!q) return jsonResponse(404, { detail: "Impossible de deplacer la question" });

        const rows = db.questions.filter((x) => x.exercice_id === q.exercice_id).sort(byOrderThenId);
        const idx = rows.findIndex((r) => r.id === questionId);
        if (idx < 0) return jsonResponse(404, { detail: "Impossible de deplacer la question" });
        const voisin = direction < 0 ? rows[idx - 1] : rows[idx + 1];
        if (!voisin) return jsonResponse(404, { detail: "Impossible de deplacer la question" });

        const old = q.ordre;
        q.ordre = voisin.ordre;
        voisin.ordre = old;
        saveDb();
        return jsonResponse(200, { success: true });
      }
    }

    {
      const m = path.match(/^\/notes\/(\d+)\/(\d+)$/);
      if (m && method === "PUT") {
        const etudiantId = toInt(m[1], 0);
        const questionId = toInt(m[2], 0);
        const body = await requestJson(req);
        const valeur = body.valeur == null ? null : toNum(body.valeur, null);
        const commentaire = body.commentaire == null ? null : String(body.commentaire);

        if (valeur != null && (Number.isNaN(valeur) || valeur < 0 || valeur > 1)) {
          return jsonResponse(422, { detail: "La valeur doit etre comprise entre 0 et 1" });
        }

        const etu = db.etudiants.find((e) => e.id === etudiantId);
        const q = db.questions.find((x) => x.id === questionId);
        if (!etu || !q) return jsonResponse(404, { detail: "Etudiant ou question introuvable" });

        let row = db.notes.find((n) => n.etudiant_id === etudiantId && n.question_id === questionId);
        if (!row) {
          row = {
            id: nextId("notes"),
            etudiant_id: etudiantId,
            question_id: questionId,
            valeur,
            commentaire,
          };
          db.notes.push(row);
        } else {
          row.valeur = valeur;
          row.commentaire = commentaire;
        }
        saveDb();
        return jsonResponse(200, { question_id: questionId, valeur, commentaire });
      }

      if (m && method === "DELETE") {
        const etudiantId = toInt(m[1], 0);
        const questionId = toInt(m[2], 0);
        const before = db.notes.length;
        db.notes = db.notes.filter((n) => !(n.etudiant_id === etudiantId && n.question_id === questionId));
        if (db.notes.length === before) return jsonResponse(404, { detail: "Note introuvable" });
        saveDb();
        return emptyResponse(204);
      }
    }

    {
      const m = path.match(/^\/notes\/(\d+)\/devoir\/(\d+)$/);
      if (m && method === "GET") {
        const etudiantId = toInt(m[1], 0);
        const devoirId = toInt(m[2], 0);
        return jsonResponse(200, getNotesEtudiantDevoir(etudiantId, devoirId));
      }
    }

    {
      const m = path.match(/^\/devoirs\/(\d+)\/resultats$/);
      if (m && method === "GET") {
        const devoirId = toInt(m[1], 0);
        const devoir = db.devoirs.find((d) => d.id === devoirId);
        if (!devoir) return jsonResponse(404, { detail: "Devoir introuvable" });
        const groupeId = url.searchParams.get("groupe_id");
        const gid = groupeId == null || groupeId === "" ? null : toInt(groupeId, null);
        return jsonResponse(200, getResultatsDevoir(devoirId, gid));
      }
    }

    {
      const m = path.match(/^\/devoirs\/(\d+)\/export-csv$/);
      if (m && method === "GET") {
        const devoirId = toInt(m[1], 0);
        const groupeId = url.searchParams.get("groupe_id");
        const gid = groupeId == null || groupeId === "" ? null : toInt(groupeId, null);
        const devoir = buildDevoirById(devoirId);
        if (!devoir) return jsonResponse(404, { detail: "Devoir introuvable" });

        const resultats = getResultatsDevoir(devoirId, gid);
        const questions = devoir.exercices.flatMap((ex) => ex.questions);

        const header = [
          "Nom",
          "Prenom",
          "Email",
          "Groupe",
          "Classement groupe",
          "Copies corrigees groupe",
          ...questions.map((q) => `Q${Number(q.ordre || 0) + 1} (${q.poids}pt)`),
          "Total brut",
          "Sur",
          "Bonus abs /20",
          "Bonus %",
          "Note finale /20",
        ];

        const rows = [header];
        for (const r of resultats) {
          const notesMap = new Map((r.notes || []).map((n) => [n.question_id, n.valeur]));
          rows.push([
            r.etudiant.nom,
            r.etudiant.prenom,
            r.etudiant.email || "",
            r.groupe_nom || "",
            r.classement_groupe == null ? "" : r.classement_groupe,
            r.nb_corrigees_groupe,
            ...questions.map((q) => {
              const v = notesMap.get(q.id);
              return v == null ? "" : v;
            }),
            r.note_totale,
            r.poids_total,
            r.bonus_abs,
            r.bonus_pct,
            r.note_sur_20,
          ]);
        }

        const csv = rows
          .map((line) => line.map((v) => String(v).replace(/;/g, ",")).join(";"))
          .join("\n");
        const filename = `resultats_${String(devoir.titre).replace(/\s+/g, "_")}.csv`;

        return textResponse(200, csv, "text/csv; charset=utf-8", {
          "Content-Disposition": `attachment; filename=\"${filename}\"`,
        });
      }
    }

    {
      const m = path.match(/^\/devoirs\/(\d+)\/mail-template$/);
      if (m && (method === "GET" || method === "POST")) {
        const devoirId = toInt(m[1], 0);
        const groupeId = url.searchParams.get("groupe_id");
        const gid = groupeId == null || groupeId === "" ? null : toInt(groupeId, null);
        const devoir = buildDevoirById(devoirId);
        if (!devoir) return jsonResponse(404, { detail: "Devoir introuvable" });

        const resultats = getResultatsDevoir(devoirId, gid);
        const body = method === "POST" ? await requestJson(req) : {};
        const out = buildMailTemplates(devoir, resultats, parseMailConfig(body));
        return jsonResponse(200, out);
      }
    }

    return jsonResponse(404, { detail: "Route offline introuvable" });
  }

  window.fetch = async function (input, init) {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url, window.location.href);

    const isApiTarget = url.origin === API_ORIGIN;
    if (!isApiTarget) {
      return nativeFetch(input, init);
    }

    try {
      return await handleApi(req, url);
    } catch (err) {
      return jsonResponse(500, { detail: `Erreur offline: ${err.message}` });
    }
  };

  window.CORRIGATOR_RUNTIME = "offline";
})();
