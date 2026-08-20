// scripts/update-values.mjs
//
// Aggiorna il campo "value" (valore di mercato in EUR) SOLO per le carte che
// hanno già un campo "justtcgId" impostato a mano sul Gist. Nessuna ricerca
// automatica per nome: l'id va trovato e incollato a mano sulla pagina della
// carta su justtcg.com (campo "slug (v1 id)"), così non c'è rischio di
// prendere la versione sbagliata (es. alt art vs normale).
//
// Aggiorna più "profili" nella stessa run: il tuo Gist + fino a 2 Gist di
// amici (se hai le loro credenziali), tutti con la stessa chiave JustTCG.
//
// Variabili d'ambiente richieste:
//   GIST_TOKEN          token GitHub (permesso "gist") del tuo account
//   GIST_ID              id del tuo Gist
//   JUSTTCG_API_KEY       chiave API di justtcg.com (piano free va bene, condivisa tra tutti i profili)
//   GAME_FILTER           'all' oppure uno tra 'Dragon Ball' | 'Digimon' | 'Pokémon' | 'One Piece'
//   DEBUG                 'true' per stampare nei log la risposta grezza del primo batch
//
// Opzionali, per aggiornare anche le collezioni di amici:
//   FRIEND1_GIST_TOKEN, FRIEND1_GIST_ID, FRIEND1_LABEL (facoltativa, solo per i log)
//   FRIEND2_GIST_TOKEN, FRIEND2_GIST_ID, FRIEND2_LABEL

const JUSTTCG_API_KEY = process.env.JUSTTCG_API_KEY;
const GAME_FILTER = process.env.GAME_FILTER || 'all';
const DEBUG = process.env.DEBUG === 'true';

const COLLECTION_FILENAME = 'dbsfw_collection.json';
const JUSTTCG_BASE = 'https://api.justtcg.com/v1';

// Free plan JustTCG: 10 richieste al minuto -> aspettiamo un po' più di 6s tra un batch e l'altro.
const SLEEP_MS = 6500;
// Budget TOTALE di richieste JustTCG per l'intera run, condiviso tra tutti i profili
// (tenuto sotto il limite reale di 100/giorno, per margine di sicurezza).
const DAILY_BUDGET = 90;

const PROFILES = [
  { label: 'Tu', token: process.env.GIST_TOKEN, gistId: process.env.GIST_ID },
];
if (process.env.FRIEND1_GIST_TOKEN && process.env.FRIEND1_GIST_ID) {
  PROFILES.push({
    label: process.env.FRIEND1_LABEL || 'Amico 1',
    token: process.env.FRIEND1_GIST_TOKEN,
    gistId: process.env.FRIEND1_GIST_ID,
  });
}
if (process.env.FRIEND2_GIST_TOKEN && process.env.FRIEND2_GIST_ID) {
  PROFILES.push({
    label: process.env.FRIEND2_LABEL || 'Amico 2',
    token: process.env.FRIEND2_GIST_TOKEN,
    gistId: process.env.FRIEND2_GIST_ID,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Risposta non JSON da ${url}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} da ${url}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

// --- Cambio USD -> EUR (Frankfurter, gratis, senza chiave) — una volta sola per tutta la run ---
async function getUsdToEurRate() {
  const FALLBACK_RATE = 0.92;
  try {
    const data = await fetchJson('https://api.frankfurter.dev/v1/latest?from=USD&to=EUR');
    if (data?.rates?.EUR) {
      log(`Tasso USD->EUR live: ${data.rates.EUR}`);
      return data.rates.EUR;
    }
  } catch (err) {
    log('Impossibile ottenere il tasso di cambio live, uso il fallback:', err.message);
  }
  return FALLBACK_RATE;
}

// --- Scegli la variante "migliore" tra quelle della carta trovata ---
const ALT_ART_KEYWORDS = [
  'alt art', 'alternate art', 'alt-art', 'special art', 'parallel',
  'special illustration', 'full art', 'secret', 'sar', ' ar ', 'gold stamped',
  'holo rare', 'textured',
];
function looksLikeAltArt(str) {
  const s = ` ${(str || '').toLowerCase()} `;
  return ALT_ART_KEYWORDS.some((kw) => s.includes(kw));
}
function pickVariant(card) {
  const variants = card.variants || [];
  if (!variants.length) return null;
  const altNm = variants.find(
    (v) => looksLikeAltArt(v.printing) && (v.condition || '').toLowerCase().includes('near mint')
  );
  if (altNm) return altNm;
  const alt = variants.find((v) => looksLikeAltArt(v.printing));
  if (alt) return alt;
  const nm = variants.find((v) => (v.condition || '').toLowerCase().includes('near mint'));
  return nm || variants[0];
}

// --- Lookup "in batch" per id (fino a 20 per richiesta sul piano free) ---
async function batchLookup(cardIds) {
  const body = JSON.stringify(cardIds.map((id) => ({ cardId: id })));
  const data = await fetchJson(`${JUSTTCG_BASE}/cards`, {
    method: 'POST',
    headers: {
      'x-api-key': JUSTTCG_API_KEY,
      'Content-Type': 'application/json',
    },
    body,
  });
  return data.data || [];
}

// --- Aggiorna UN profilo (un Gist). Ritorna quante richieste JustTCG ha usato. ---
async function updateProfile(profile, usdToEur, requestBudgetLeft, debugState) {
  const { label, token, gistId } = profile;
  log(`--- Profilo: ${label} ---`);

  if (!token || !gistId) {
    log(`${label}: token o Gist ID mancanti, salto.`);
    return 0;
  }

  let requestsUsed = 0;

  // 1. Leggi il Gist
  let gist;
  try {
    gist = await fetchJson(`https://api.github.com/gists/${gistId}`, {
      headers: { Authorization: `token ${token}`, 'User-Agent': 'trackalo-price-updater' },
    });
  } catch (err) {
    log(`${label}: errore leggendo il Gist:`, err.message);
    return 0;
  }
  const file = gist.files[COLLECTION_FILENAME];
  if (!file) {
    log(`${label}: file ${COLLECTION_FILENAME} non trovato nel Gist, salto.`);
    return 0;
  }
  const cards = JSON.parse(file.content);
  log(`${label}: carte totali nel Gist: ${cards.length}`);

  // 2. Seleziona le carte da aggiornare: solo quelle con justtcgId impostato
  const inScope = cards.filter((c) => GAME_FILTER === 'all' || (c.game || 'Dragon Ball') === GAME_FILTER);
  const withId = inScope.filter((c) => c.justtcgId);
  const withoutId = inScope.length - withId.length;
  log(`${label}: in ambito ${inScope.length} (con ID: ${withId.length}, senza ID - ignorate: ${withoutId})`);

  let updatedCount = 0;
  const notFound = [];

  for (const group of chunk(withId, 20)) {
    if (requestsUsed + requestBudgetLeft.used >= DAILY_BUDGET) {
      log(`${label}: budget condiviso esaurito, il resto delle carte verrà ritentato domani.`);
      break;
    }
    try {
      const results = await batchLookup(group.map((c) => c.justtcgId));
      requestsUsed++;
      requestBudgetLeft.used++;

      if (DEBUG && !debugState.printed) {
        debugState.printed = true;
        log(`[DEBUG] Risposta grezza batch (${label}): ${JSON.stringify(results).slice(0, 2000)}`);
      }

      for (const card of group) {
        const match = results.find((r) => r.id === card.justtcgId);
        if (!match) {
          notFound.push(`${card.code} (${card.name}) - id: ${card.justtcgId}`);
          continue;
        }
        const variant = pickVariant(match);
        if (!variant || typeof variant.price !== 'number') {
          notFound.push(`${card.code} (${card.name}) - nessun prezzo nella variante`);
          continue;
        }
        card.value = round2(variant.price * usdToEur);
        updatedCount++;
      }
    } catch (err) {
      log(`${label}: errore nel batch lookup:`, err.message);
      group.forEach((card) => notFound.push(`${card.code} (${card.name}) - errore: ${err.message}`));
    }
    await sleep(SLEEP_MS);
  }

  // 3. Salva solo il file della collezione sul Gist (non tocca budget/friends/album)
  if (updatedCount > 0) {
    try {
      await fetchJson(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `token ${token}`,
          'User-Agent': 'trackalo-price-updater',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          files: { [COLLECTION_FILENAME]: { content: JSON.stringify(cards, null, 2) } },
        }),
      });
    } catch (err) {
      log(`${label}: errore salvando sul Gist:`, err.message);
    }
  }

  log(`${label}: fatto. Carte aggiornate: ${updatedCount}.`);
  if (notFound.length) log(`${label}: problemi (${notFound.length}):`, notFound.join(' | '));

  return { requestsUsed, updatedCount, withIdCount: withId.length, withoutId, notFound };
}

// --- MAIN ---
async function main() {
  if (!JUSTTCG_API_KEY) {
    throw new Error('Manca la variabile d\'ambiente JUSTTCG_API_KEY');
  }

  log(`Avvio. Filtro gioco: ${GAME_FILTER}. Profili da aggiornare: ${PROFILES.map((p) => p.label).join(', ')}.`);

  const usdToEur = await getUsdToEurRate();
  const requestBudgetLeft = { used: 0 };
  const debugState = { printed: false };

  const results = [];
  for (const profile of PROFILES) {
    if (requestBudgetLeft.used >= DAILY_BUDGET) {
      log(`Budget condiviso esaurito, salto il profilo "${profile.label}" (ripartirà domani).`);
      continue;
    }
    const r = await updateProfile(profile, usdToEur, requestBudgetLeft, debugState);
    results.push({ label: profile.label, ...r });
  }

  // Riepilogo complessivo
  const totalUpdated = results.reduce((s, r) => s + (r.updatedCount || 0), 0);
  log(`Fatto tutto. Richieste JustTCG usate in totale: ${requestBudgetLeft.used}. Carte aggiornate in totale: ${totalUpdated}.`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import('node:fs/promises');
    const lines = [
      '## Aggiornamento valori Trackalo',
      '',
      `- Richieste JustTCG usate: ${requestBudgetLeft.used} / ${DAILY_BUDGET}`,
      `- Carte aggiornate in totale: ${totalUpdated}`,
      '',
    ];
    for (const r of results) {
      lines.push(`### ${r.label}`);
      lines.push(`- Con ID: ${r.withIdCount ?? 0}, aggiornate: ${r.updatedCount ?? 0}, senza ID: ${r.withoutId ?? 0}`);
      if (r.notFound?.length) lines.push(`- Problemi: ${r.notFound.join(' | ')}`);
      lines.push('');
    }
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
}

main().catch((err) => {
  console.error('Errore fatale:', err);
  process.exit(1);
});
