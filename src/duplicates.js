// Finds reports that look like they are about the SAME person.
//
// Why it matters here: when one person is filed twice, their record splits in
// half. A rescuer who has that person in front of them matches one half and
// sees one family's phone number — the other family is never called, and never
// knows the site had their relative all along.
//
// This module is ADVISORY, always. A suspected duplicate NEVER blocks a report
// and never rejects one: in an emergency the worst possible outcome is a report
// the system threw away because it believed it already had it. Everything here
// produces a warning; nothing here changes a record, and the data lands either
// way. Callers run it AFTER the write for the same reason — see POST /report.
//
// Two independent signals:
//   face — the strong one, and the only one a person can verify with their own
//          eyes. Pass `excludePersonId` so the report's own freshly-indexed
//          photos don't come back as matches on themselves.
//   name — the weak one, and the one that already acts alone: a name scoring
//          >= 0.85 is merged by findOrCreatePerson before this module is asked
//          anything. What is left for us is the band below that, where the
//          names are close enough to deserve a human's eyes but not close
//          enough to merge unasked.

const { matcherReady } = require('./faces');

// Deliberately below findOrCreatePerson's 0.85 auto-merge and above the 0.55
// used for open search: this is the "worth asking about" band, not a new
// merging rule. The calibrated 0.85/0.55 thresholds are untouched.
const NAME_HINT_SCORE = 0.6;

const MAX_CANDIDATES = 4;

// Returns [{ person, photo, update, reason: 'face'|'name', similarity }],
// strongest first. Empty when nothing looks like a duplicate.
//
// NOTHING in here is allowed to throw. report-admission.js runs this LAST,
// once the report is already written, indexed and notified — but an
// exception escaping this function would still turn an already-successful
// report into a 500 for the family waiting on the response, over a courtesy
// feature that was never allowed to matter that much. Every failure degrades
// to "no candidates found" and a log line.
async function findDuplicateCandidates(
  store,
  matcher,
  { name, photos: photoBuffers = [], excludePersonId = null, limit = MAX_CANDIDATES } = {}
) {
  try {
    const byPerson = new Map();
    const isExcluded = (id) => excludePersonId != null && String(id) === String(excludePersonId);

    // Every uploaded photo is searched, not just the first: a family often
    // leads with a group shot where no face is usable, and the portrait that
    // would have matched an existing report sits at #2.
    const usable = (photoBuffers || []).filter((b) => b && b.length);
    // En el flujo actual de report-admission.js esto corre LAST, después de
    // que processPhoto ya indexó (y despertó) el matcher para las mismas
    // fotos — así que `matcherReady` suele ser un no-op para cuando llega
    // acá. Se llama igual porque esta función también se invoca directo
    // (pruebas, y cualquier llamador futuro que busque duplicados sin indexar
    // antes), y no puede asumir que alguien más ya despertó el matcher.
    // Adentro del try a propósito — un despertar fallido degrada a "sin
    // candidatos", nunca en un reporte roto.
    if (matcher && usable.length && (await matcherReady(matcher))) {
      for (const bytes of usable) {
        try {
          const hits = await matcher.searchByImage(bytes);
          if (!hits.length) continue;
          const similarityByFace = new Map(hits.map((h) => [h.faceId, h.similarity]));
          for (const photo of await store.photosByFaceIds([...similarityByFace.keys()])) {
            // A rescuer's face ('query') means someone is HOLDING this person —
            // that is a match, not a duplicate report. Only reports count here.
            if (photo.kind !== 'report') continue;
            if (isExcluded(photo.person_id)) continue;
            const similarity = similarityByFace.get(photo.face_id) || 0;
            const seen = byPerson.get(photo.person_id);
            if (!seen || similarity > seen.similarity) {
              byPerson.set(photo.person_id, { personId: photo.person_id, reason: 'face', similarity });
            }
          }
        } catch (e) {
          // Rekognition being down must never break reporting.
          console.error('[duplicados] la búsqueda facial falló:', e && e.message);
        }
      }
    }

    for (const p of await store.searchPeople(name || '', { limit: 5, minScore: NAME_HINT_SCORE })) {
      if (isExcluded(p.id)) continue;
      // A face verdict already exists for this person and says more than a name.
      if (byPerson.has(p.id)) continue;
      byPerson.set(p.id, { personId: p.id, reason: 'name', similarity: p.score * 100 });
    }

    if (!byPerson.size) return [];

    // Face first, then by strength: the photo is what a human can actually judge.
    const ranked = [...byPerson.values()]
      .sort((a, b) => (a.reason === b.reason ? b.similarity - a.similarity : a.reason === 'face' ? -1 : 1))
      .slice(0, limit);

    const photos = await store.reportPhotoByPerson(ranked.map((c) => c.personId));
    // Hydrated concurrently: the ids are all known here, and awaiting them one
    // by one added a round trip per candidate to a request a family is waiting on.
    const out = await Promise.all(
      ranked.map(async (c) => {
        const person = await store.getPerson(c.personId);
        if (!person) return null;
        return {
          person,
          photo: photos.get(c.personId) || null,
          update: await store.getLatestUpdate(c.personId),
          reason: c.reason,
          similarity: Math.round(c.similarity)
        };
      })
    );
    return out.filter(Boolean);
  } catch (e) {
    console.error('[duplicados] la detección falló por completo:', e && e.message);
    return [];
  }
}

// One sentence in Spanish describing what the caller should know, or null when
// there is nothing to warn about. Used by the API response and the web screen.
function duplicateWarning({ mergedIntoExisting, candidates }) {
  const parts = [];
  if (mergedIntoExisting) {
    parts.push(
      'Ya existía una persona con este nombre: el reporte se sumó a su historial en vez de crear un registro nuevo.'
    );
  }
  const faces = candidates.filter((c) => c.reason === 'face');
  if (faces.length) {
    const best = Math.max(...faces.map((c) => c.similarity));
    parts.push(
      faces.length === 1
        ? `La foto coincide en un ${best}% con otro reporte ya publicado: puede ser la misma persona reportada dos veces.`
        : `La foto coincide con ${faces.length} reportes ya publicados (hasta ${best}%): puede ser la misma persona reportada varias veces.`
    );
  }
  const names = candidates.filter((c) => c.reason === 'name');
  if (names.length) {
    parts.push(
      names.length === 1
        ? 'Hay otro reporte con un nombre muy parecido.'
        : `Hay ${names.length} reportes con nombres muy parecidos.`
    );
  }
  return parts.length ? parts.join(' ') : null;
}

module.exports = { findDuplicateCandidates, duplicateWarning, NAME_HINT_SCORE };
