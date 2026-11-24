/* Le Mur — fonctions communes */
const Mur = (() => {
  const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (_) {} return null; };
  const owner = () => { let t = LS('mur_owner'); if (!t) { t = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join(''); LS('mur_owner', t); } return t; };
  const mine = () => { try { return JSON.parse(LS('mur_mine') || '{}'); } catch (_) { return {}; } };
  const addMine = (id) => { const m = mine(); m[id] = 1; LS('mur_mine', JSON.stringify(m)); };
  const delMine = (id) => { const m = mine(); delete m[id]; LS('mur_mine', JSON.stringify(m)); };
  const myReacts = () => { try { return JSON.parse(LS('mur_rx') || '{}'); } catch (_) { return {}; } };

  const api = async (url, opts = {}) => {
    const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    let j = {}; try { j = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(j.error || ('Erreur ' + r.status));
    return j;
  };
  const config = () => api('/api/config');

  const toast = (msg, ms = 2600) => {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), ms);
  };

  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
  const ago = (t) => {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return "à l'instant";
    if (s < 3600) return Math.round(s / 60) + ' min';
    if (s < 86400) return Math.round(s / 3600) + ' h';
    return Math.round(s / 86400) + ' j';
  };

  /* Construit une carte polaroïd (sans innerHTML : tout est textContent) */
  const polaroid = (p, o = {}) => {
    const el = document.createElement('article');
    el.className = 'pol' + (o.isNew ? ' new dev' : '');
    el.dataset.id = p.id;
    el.style.setProperty('--rot', ((hash(p.id) % 9) - 4) * 0.5 + 'deg');
    if (p.image) {
      const img = document.createElement('img'); img.src = p.image; img.alt = 'Photo de ' + p.name; img.loading = 'lazy';
      el.appendChild(img);
      if (p.text) { const c = document.createElement('div'); c.className = 'cap'; c.textContent = p.text; el.appendChild(c); }
    } else {
      const n = document.createElement('div'); n.className = 'note'; n.textContent = p.text; el.appendChild(n);
    }
    const who = document.createElement('div'); who.className = 'who';
    const a = document.createElement('span'); a.textContent = p.name;
    const b = document.createElement('span'); b.className = 'age'; b.dataset.t = p.createdAt; b.textContent = ago(p.createdAt);
    who.append(a, b); el.appendChild(who);
    if (!o.readonly) {
      const rx = document.createElement('div'); rx.className = 'rx'; rx.dataset.rx = '1'; el.appendChild(rx);
      renderReactions(el, p.reactions || {}, o.reactions || [], o.onReact);
      if (mine()[p.id]) {
        const d = document.createElement('button'); d.className = 'del'; d.title = 'Supprimer ma publication'; d.textContent = '✕';
        d.onclick = () => o.onDelete && o.onDelete(p.id);
        el.appendChild(d);
      }
    }
    return el;
  };
  const renderReactions = (el, counts, list, onReact) => {
    const rx = el.querySelector('[data-rx]'); if (!rx) return;
    rx.textContent = '';
    const my = myReacts();
    list.forEach((e) => {
      const btn = document.createElement('button');
      const c = counts[e] || 0;
      btn.textContent = c ? e + ' ' + c : e;
      if (my[el.dataset.id + e]) btn.className = 'has';
      btn.onclick = () => onReact && onReact(el.dataset.id, e);
      rx.appendChild(btn);
    });
  };
  const markReacted = (id, e) => { const m = myReacts(); m[id + e] = 1; LS('mur_rx', JSON.stringify(m)); };

  const stream = (h) => {
    const es = new EventSource('/api/stream');
    ['post', 'delete', 'react'].forEach((t) => es.addEventListener(t, (ev) => { try { h[t] && h[t](JSON.parse(ev.data)); } catch (_) {} }));
    es.onopen = () => h.open && h.open();
    es.onerror = () => h.error && h.error();
    return es;
  };

  const DEFIS = [
    "Selfie avec la personne que tu connais le moins ici",
    "Dessine le DJ (ou la playlist) 🎧",
    "Photo de groupe : tout le monde fait la même grimace",
    "Écris un souhait pour le·la héros·ïne de la soirée",
    "Selfie avec la personne la plus grande de la salle",
    "Reproduis un tableau célèbre à plusieurs",
    "Dessine-toi en super-héros ou super-héroïne 🦸",
    "Photo de ta main qui tient quelque chose de ridicule",
    "Écris le souvenir le plus fou lié à cette soirée",
    "Selfie « on se connaît depuis toujours » avec un inconnu",
    "Dessine ton animal totem et colle-lui un chapeau",
    "Photo des pieds de tout le monde en cercle 🦶"
  ];
  const defi = (skip) => { let d; do { d = DEFIS[Math.floor(Math.random() * DEFIS.length)]; } while (d === skip && DEFIS.length > 1); return d; };

  return { LS, owner, mine, addMine, delMine, api, config, toast, ago, polaroid, renderReactions, markReacted, stream, defi };
})();
