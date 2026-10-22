// Foci cloud bridge — real accounts + cross-device sync via Supabase.
// Loaded by both index.html and app.html, right after the Supabase CDN
// script and right before each page calls its own init function below.
// The app itself still reads/writes everything through localStorage
// ("foci-*" keys) exactly as before; this file is the only thing that
// knows a Supabase account exists underneath that.
(function () {
  "use strict";

  var SUPABASE_URL = "https://yxeezycbtziavybjmpsk.supabase.co";
  var SUPABASE_KEY = "sb_publishable_A5FalypwSQA8OXkpYrIPCA_GZrAanlB";
  var BUCKET = "user-files";
  var STATE_FILE = ".image-slots.state.json";
  // Never leave the device: short-lived Spotify PKCE artifacts.
  var EXCLUDE = { "foci-sp-token": 1, "foci-sp-verifier": 1 };

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  var userId = null;
  var syncTimer = null;

  function fociKeys() {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf("foci-") === 0) out.push(k);
    }
    return out;
  }

  function clearLocalFociKeys() {
    fociKeys().forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) {}
    });
  }

  function loadSupportScript() {
    var s = document.createElement("script");
    s.src = "./support.js";
    document.head.appendChild(s);
  }

  // ── cloud <-> localStorage blob sync ────────────────────────────────────

  function hydrateFromCloud() {
    return client
      .from("user_state")
      .select("data")
      .eq("user_id", userId)
      .maybeSingle()
      .then(function (res) {
        var row = res.data;
        if (!row || !row.data) return;
        Object.keys(row.data).forEach(function (k) {
          if (k.indexOf("foci-") !== 0 || EXCLUDE[k]) return;
          try { localStorage.setItem(k, row.data[k]); } catch (e) {}
        });
      })
      .catch(function (err) { console.error("[fociCloud] hydrate failed", err); });
  }

  function flushNow() {
    if (!userId) return Promise.resolve();
    clearTimeout(syncTimer);
    var payload = {};
    fociKeys().forEach(function (k) {
      if (EXCLUDE[k]) return;
      payload[k] = localStorage.getItem(k);
    });
    return client
      .from("user_state")
      .upsert({ user_id: userId, data: payload, updated_at: new Date().toISOString() })
      .then(function (res) { if (res.error) console.error("[fociCloud] sync failed", res.error); })
      .catch(function (err) { console.error("[fociCloud] sync failed", err); });
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(flushNow, 1500);
  }

  function installSyncWatchers() {
    var origSet = localStorage.setItem.bind(localStorage);
    var origRemove = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      origSet(k, v);
      if (k.indexOf("foci-") === 0 && !EXCLUDE[k]) scheduleSync();
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      if (k.indexOf("foci-") === 0 && !EXCLUDE[k]) scheduleSync();
    };
    window.addEventListener("beforeunload", flushNow);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") flushNow();
    });
  }

  // ── Supabase Storage (vision board / profile images, imported video) ───

  function uploadFile(file, idHint) {
    var ext = (file.name && file.name.split(".").pop() || "bin").toLowerCase();
    var path = userId + "/" + idHint + "-" + Date.now() + "." + ext;
    return client.storage
      .from(BUCKET)
      .upload(path, file, { contentType: file.type || undefined, upsert: true })
      .then(function (res) {
        if (res.error) throw res.error;
        return client.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      });
  }

  function dataUrlToUpload(dataUrl, idHint) {
    return fetch(dataUrl)
      .then(function (r) { return r.blob(); })
      .then(function (blob) { return uploadFile(blob, idHint); });
  }

  // <image-slot> (profile photo + vision board pictures) only persists
  // drops when a design-tool bridge (window.omelette) is present, and
  // reads its initial state from a static sidecar file baked at design
  // time. Outside that tool — i.e. on Vercel — we stand in for both: the
  // "sidecar" becomes this account's foci-image-slots key, and a drop
  // uploads to Supabase Storage instead of writing a file.
  function installImageSlotShim() {
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem("foci-image-slots") || "null"); } catch (e) {}

    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.indexOf(STATE_FILE) !== -1) {
        return Promise.resolve(
          new Response(JSON.stringify(cached || {}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );
      }
      return origFetch(input, init);
    };

    window.omelette = window.omelette || {};
    window.omelette.writeFile = function (path, content) {
      if (path.indexOf(STATE_FILE) === -1) return Promise.resolve();
      var slots;
      try { slots = JSON.parse(content); } catch (e) { return Promise.resolve(); }
      var ids = Object.keys(slots);
      return Promise.all(
        ids.map(function (id) {
          var v = typeof slots[id] === "string" ? { u: slots[id], s: 1, x: 0, y: 0 } : slots[id];
          if (v && v.u && v.u.indexOf("data:") === 0) {
            return dataUrlToUpload(v.u, id)
              .then(function (url) { v.u = url; return [id, v]; })
              .catch(function (err) { console.error("[fociCloud] image upload failed", err); return [id, v]; });
          }
          return Promise.resolve([id, v]);
        })
      ).then(function (pairs) {
        var out = {};
        pairs.forEach(function (p) { out[p[0]] = p[1]; });
        cached = out;
        try { localStorage.setItem("foci-image-slots", JSON.stringify(out)); } catch (e) {}
      });
    };
  }

  // ── auth ─────────────────────────────────────────────────────────────────

  function signUp(email, password, name) {
    return client.auth.signUp({ email: email, password: password, options: { data: { name: name } } });
  }

  function signIn(email, password) {
    return client.auth.signInWithPassword({ email: email, password: password });
  }

  function goToApp() {
    location.href = "app.html" + location.search;
  }

  function signOutAndLeave() {
    return flushNow()
      .then(function () { return client.auth.signOut(); })
      .catch(function () {})
      .then(function () {
        clearLocalFociKeys();
        location.href = "index.html";
      });
  }

  // ── projects + email invites ─────────────────────────────────────────────

  var addDaysFrom = function (base, n) {
    var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  };

  // Same four demo projects the mockup always showed, carried over once per
  // account into real rows (offsets preserved relative to today instead of
  // the fixed Oct 21 2026 the mockup used to assume "today" was).
  function demoProjects() {
    var t = new Date();
    return [
      { title: "Physics lab report — Group B", type: "Physics", start: addDaysFrom(t, -15), end: addDaysFrom(t, 6), role: "Lead",
        data: { progress: 65, hours: 11.5, ms: [{ t: "Data collected", date: addDaysFrom(t, -7), done: true }, { t: "First draft", date: addDaysFrom(t, 1), done: false }, { t: "Submit report", date: addDaysFrom(t, 6), done: false }] } },
      { title: "History presentation: WWI", type: "History", start: addDaysFrom(t, -8), end: addDaysFrom(t, 16), role: "Member",
        data: { progress: 30, hours: 4, ms: [{ t: "Pick sources", date: addDaysFrom(t, -3), done: true }, { t: "Slides done", date: addDaysFrom(t, 12), done: false }, { t: "Present", date: addDaysFrom(t, 16), done: false }] } },
      { title: "Math group project — Optimization", type: "Math", start: addDaysFrom(t, -1), end: addDaysFrom(t, 38), role: "Member",
        data: { progress: 10, hours: 1.5, ms: [{ t: "Problem statement", date: addDaysFrom(t, 6), done: false }, { t: "Model + code", date: addDaysFrom(t, 27), done: false }, { t: "Final write-up", date: addDaysFrom(t, 38), done: false }] } },
      { title: "Personal: portfolio website", type: "Personal", start: addDaysFrom(t, -22), end: addDaysFrom(t, 55), role: "Lead",
        data: { progress: 45, hours: 18, ms: [{ t: "Design", date: addDaysFrom(t, -6), done: true }, { t: "Build", date: addDaysFrom(t, 30), done: false }, { t: "Launch", date: addDaysFrom(t, 55), done: false }] } },
    ];
  }

  function seedDemoProjectsIfEmpty() {
    return client.from("projects").select("id", { count: "exact", head: true }).then(function (res) {
      if (res.count) return;
      var email = null;
      return client.auth.getUser().then(function (u) {
        email = u.data && u.data.user && u.data.user.email;
        var rows = demoProjects();
        return rows.reduce(function (chain, p) {
          return chain.then(function () {
            return client.from("projects").insert({ owner_id: userId, title: p.title, type: p.type, start: p.start, end: p.end, data: p.data }).select("id").single()
              .then(function (pr) {
                if (pr.error) throw pr.error;
                return client.from("project_members").insert({ project_id: pr.data.id, user_id: userId, email: email, role: p.role, status: "accepted", accepted_at: new Date().toISOString() });
              });
          });
        }, Promise.resolve());
      });
    }).catch(function (err) { console.error("[fociCloud] demo seed failed", err); });
  }

  function loadProjects() {
    return seedDemoProjectsIfEmpty().then(function () {
      return client.from("projects").select("id, title, type, start, end, data, owner_id, project_members(id, user_id, email, role, status, token)");
    }).then(function (res) {
      if (res.error) throw res.error;
      return res.data || [];
    });
  }

  function createProject(title, type, start, end, data) {
    var email = null;
    return client.auth.getUser().then(function (u) {
      email = u.data && u.data.user && u.data.user.email;
      return client.from("projects").insert({ owner_id: userId, title: title, type: type, start: start, end: end, data: data || {} }).select().single();
    }).then(function (res) {
      if (res.error) throw res.error;
      return client.from("project_members").insert({ project_id: res.data.id, user_id: userId, email: email, role: "Lead", status: "accepted", accepted_at: new Date().toISOString() })
        .then(function () { return res.data; });
    });
  }

  function updateProjectData(projectId, data) {
    return client.from("projects").update({ data: data, updated_at: new Date().toISOString() }).eq("id", projectId);
  }

  function deleteProject(projectId) {
    return client.from("projects").delete().eq("id", projectId);
  }

  function sendInviteEmail(token) {
    return client.functions.invoke("send-invite", { body: { token: token } })
      .catch(function (err) { console.error("[fociCloud] send-invite failed", err); });
  }

  function inviteMember(projectId, email, role) {
    return client.from("project_members").insert({ project_id: projectId, email: email, role: role, status: "pending", invited_by: userId }).select().single()
      .then(function (res) {
        if (res.error) throw res.error;
        return sendInviteEmail(res.data.token).then(function () { return res.data; });
      });
  }

  function resendInvite(token) {
    return sendInviteEmail(token);
  }

  function removeMember(memberId) {
    return client.from("project_members").delete().eq("id", memberId);
  }

  function getInvitePreview(token) {
    return client.rpc("get_invite", { p_token: token }).then(function (res) {
      if (res.error) throw res.error;
      return (res.data && res.data[0]) || null;
    });
  }

  function acceptInvite(token) {
    return client.rpc("accept_invite", { p_token: token }).then(function (res) {
      if (res.error) throw res.error;
      return res.data;
    });
  }

  // ── page entry points ────────────────────────────────────────────────────

  function initLanding() {
    return client.auth.getSession().then(function (res) {
      if (res.data && res.data.session) {
        location.replace("app.html" + location.search);
        return;
      }
      loadSupportScript();
    });
  }

  function initApp() {
    return client.auth.getSession().then(function (res) {
      var session = res.data && res.data.session;
      if (!session) {
        location.replace("index.html");
        return;
      }
      userId = session.user.id;
      window.fociCloud.userId = userId;
      window.fociCloud.userEmail = session.user.email;
      return hydrateFromCloud().then(function () {
        installImageSlotShim();
        installSyncWatchers();
        loadSupportScript();
      });
    });
  }

  window.fociCloud = {
    userId: null,
    userEmail: null,
    initLanding: initLanding,
    initApp: initApp,
    signUp: signUp,
    signIn: signIn,
    goToApp: goToApp,
    signOutAndLeave: signOutAndLeave,
    uploadFile: function (file, idHint) { return uploadFile(file, idHint); },
    flushNow: flushNow,
    clearLocalFociKeys: clearLocalFociKeys,
    loadProjects: loadProjects,
    createProject: createProject,
    updateProjectData: updateProjectData,
    deleteProject: deleteProject,
    inviteMember: inviteMember,
    resendInvite: resendInvite,
    removeMember: removeMember,
    getInvitePreview: getInvitePreview,
    acceptInvite: acceptInvite,
  };
})();
