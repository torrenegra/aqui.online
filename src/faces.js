// Face matching provider. Production: AWS Rekognition (a collection of indexed
// faces; each new photo is searched against it). Without AWS credentials the
// null matcher is used: photos are stored but no matching happens.
//
// PRIVACY: a RESCUER's photo is only ever sent to the face-matching provider
// for comparison and is dropped immediately — it is never stored or shown.
// A REPORT photo is stored and is shown publicly alongside the detection
// geometry (see GET /photo/:id and src/html.js facePlate).

// Keeps the pre-rename name ON PURPOSE. This is not branding: it identifies the
// Rekognition collection holding every face indexed so far. Changing the
// default would point production at a new, empty collection and silently break
// matching for everyone already in it. Renaming it means migrating the
// collection and re-indexing — set FACE_COLLECTION_ID if you ever do.
const COLLECTION_ID = process.env.FACE_COLLECTION_ID || 'aqui-faces';
const THRESHOLD = parseFloat(process.env.FACE_MATCH_THRESHOLD || '90');

// Rekognition reports every coordinate as a ratio of the image (0..1), which is
// exactly what the overlay needs: it stays correct at any rendered size, so no
// image dimensions have to be stored. Only geometry is kept — never the
// demographic guesses ('ALL' also returns age/gender/emotions, which this
// service has no business recording.)
function faceGeometry(detail) {
  if (!detail || !detail.BoundingBox) return null;
  const b = detail.BoundingBox;
  return {
    box: { l: b.Left, t: b.Top, w: b.Width, h: b.Height },
    points: (detail.Landmarks || []).map((m) => ({ t: m.Type, x: m.X, y: m.Y })),
    pose: detail.Pose ? { roll: detail.Pose.Roll, yaw: detail.Pose.Yaw, pitch: detail.Pose.Pitch } : null,
    confidence: detail.Confidence ?? null
  };
}

// DeleteFaces admite hasta 4096 ids por llamada. Una persona tiene un puñado
// de fotos, pero el tope existe y salir de él es un error, no una truncación.
const DELETE_BATCH = 1000;

const nullMatcher = {
  enabled: false,
  status: 'deshabilitado (sin credenciales de AWS o error de inicialización)',
  async indexFace() {
    return { faceId: null, geometry: null };
  },
  async detectFace() {
    return null;
  },
  async searchByImage() {
    return [];
  },
  async searchByFaceId() {
    return [];
  },
  // Sin proveedor no se borra nada, y decirlo es el punto: quien pidió el
  // borrado tiene que enterarse de que la firma facial sigue donde estaba.
  async deleteFaces(faceIds) {
    return { deleted: [], unconfirmed: [...(faceIds || [])] };
  }
};

async function createMatcher() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    console.warn('[faces] AWS credentials not set — face matching disabled (photos still stored).');
    return nullMatcher;
  }
  const {
    RekognitionClient,
    CreateCollectionCommand,
    IndexFacesCommand,
    SearchFacesByImageCommand,
    SearchFacesCommand,
    DetectFacesCommand,
    DeleteFacesCommand
  } = require('@aws-sdk/client-rekognition');

  const client = new RekognitionClient({ region: process.env.AWS_REGION || 'us-east-1' });
  try {
    await client.send(new CreateCollectionCommand({ CollectionId: COLLECTION_ID }));
  } catch (e) {
    if (e.name !== 'ResourceAlreadyExistsException') {
      // Bad/expired credentials must NEVER take the app down — an emergency
      // service degrades to "photos stored, matching off", not to a crash.
      console.error('[faces] Rekognition unavailable — face matching disabled:', e.message);
      return nullMatcher;
    }
  }

  console.log(`[faces] Rekognition ready (collection ${COLLECTION_ID}, region ${process.env.AWS_REGION || 'us-east-1'})`);
  return {
    enabled: true,
    status: `activo (colección ${COLLECTION_ID})`,
    // Returns { faceId, geometry }. faceId is null when no face is detected;
    // geometry (bounding box + landmarks) may be present even then, since
    // Rekognition reports the detail of faces it declined to index.
    async indexFace(bytes, externalId) {
      const res = await client.send(
        new IndexFacesCommand({
          CollectionId: COLLECTION_ID,
          Image: { Bytes: bytes },
          ExternalImageId: String(externalId),
          MaxFaces: 1,
          QualityFilter: 'AUTO',
          // The default returns 5 landmarks; 'ALL' returns the full ~30-point
          // set that the public overlay draws.
          DetectionAttributes: ['ALL']
        })
      );
      const record = res.FaceRecords?.[0];
      const faceId = record?.Face?.FaceId || null;
      const geometry = faceGeometry(record?.FaceDetail || res.UnindexedFaces?.[0]?.FaceDetail);
      if (!faceId) {
        console.warn(
          `[faces] no face detected in photo ${externalId} (unindexed:`,
          JSON.stringify(res.UnindexedFaces || []),
          ')'
        );
      } else {
        console.log(
          `[faces] indexed photo ${externalId} as ${faceId} (${geometry?.points.length || 0} landmarks)`
        );
      }
      return { faceId, geometry };
    },
    // Geometry only, for photos already indexed: re-running IndexFaces on them
    // would add a duplicate face to the collection.
    async detectFace(bytes) {
      try {
        const res = await client.send(
          new DetectFacesCommand({ Image: { Bytes: bytes }, Attributes: ['ALL'] })
        );
        return faceGeometry(res.FaceDetails?.[0]);
      } catch (e) {
        if (e.name === 'InvalidParameterException') return null;
        throw e;
      }
    },
    // Returns [{ faceId, similarity }] above the threshold.
    async searchByImage(bytes) {
      try {
        const res = await client.send(
          new SearchFacesByImageCommand({
            CollectionId: COLLECTION_ID,
            Image: { Bytes: bytes },
            FaceMatchThreshold: THRESHOLD,
            MaxFaces: 10
          })
        );
        const matches = (res.FaceMatches || []).map((m) => ({
          faceId: m.Face.FaceId,
          similarity: m.Similarity
        }));
        console.log(`[faces] search returned ${matches.length} match(es)`);
        return matches;
      } catch (e) {
        // "no face in the image" is a normal outcome, not an error
        if (e.name === 'InvalidParameterException') {
          console.warn('[faces] search: no face detected in the uploaded photo');
          return [];
        }
        console.error('[faces] search failed:', e.name, e.message);
        throw e;
      }
    },
    // Same contract as searchByImage — [{ faceId, similarity }] above the
    // threshold — but keyed by a face already IN the collection instead of by
    // image bytes. This is what makes recounting history possible: a rescuer's
    // photo is dropped right after indexing, so its bytes are gone forever,
    // but its signature is still searchable. The searched face itself is never
    // part of the result (Rekognition excludes it).
    async searchByFaceId(faceId) {
      try {
        const res = await client.send(
          new SearchFacesCommand({
            CollectionId: COLLECTION_ID,
            FaceId: faceId,
            FaceMatchThreshold: THRESHOLD,
            MaxFaces: 20
          })
        );
        return (res.FaceMatches || []).map((m) => ({
          faceId: m.Face.FaceId,
          similarity: m.Similarity
        }));
      } catch (e) {
        // The face vanished between listing and searching (deleted person,
        // concurrent cleanup). A normal outcome for a recount, not an error.
        if (e.name === 'ResourceNotFoundException' || e.name === 'InvalidParameterException') {
          return [];
        }
        console.error('[faces] searchByFaceId failed:', e.name, e.message);
        throw e;
      }
    },
    // Retira firmas faciales de la colección. La foto vive en la base y se va
    // en cascada con su persona; la firma vive acá y no se va con nada.
    //
    // Devuelve { deleted, unconfirmed } y NO lanza: el borrado que promete la
    // política de privacidad no puede quedar bloqueado porque Rekognition esté
    // caído. `unconfirmed` es lo que la colección no confirmó haber borrado —
    // incluye tanto un fallo real como un id que ya no estaba, así que
    // reintentarlo es inofensivo.
    async deleteFaces(faceIds) {
      const ids = [...new Set((faceIds || []).filter(Boolean).map(String))];
      if (!ids.length) return { deleted: [], unconfirmed: [] };
      const deleted = [];
      for (let i = 0; i < ids.length; i += DELETE_BATCH) {
        const batch = ids.slice(i, i + DELETE_BATCH);
        try {
          const res = await client.send(
            new DeleteFacesCommand({ CollectionId: COLLECTION_ID, FaceIds: batch })
          );
          deleted.push(...(res.DeletedFaces || []));
        } catch (e) {
          console.error('[faces] delete failed:', e.name, e.message);
        }
      }
      const done = new Set(deleted);
      const unconfirmed = ids.filter((id) => !done.has(id));
      console.log(
        `[faces] deleted ${deleted.length}/${ids.length} face(s) from ${COLLECTION_ID}` +
          (unconfirmed.length ? ` — sin confirmar: ${unconfirmed.join(', ')}` : '')
      );
      return { deleted, unconfirmed };
    }
  };
}

// Serverless instances are long-lived: if Rekognition failed to initialize at
// boot (transient error, credentials added moments later), a permanently
// disabled matcher would silently break matching for that whole instance.
// This wrapper retries initialization on demand, at most once a minute.
function createLazyMatcher() {
  let real = null;
  let lastTry = 0;
  let pending = null;
  const RETRY_MS = 60000;

  async function get(now) {
    if (real && real.enabled) return real;
    // A cold instance often gets several requests at once, and each one calls
    // ensureReady(). Without this, the request that happens to run first
    // stamps `lastTry` before it awaits anything, so every request arriving
    // while it is still in flight reads `now - lastTry < RETRY_MS` as true and
    // falls back to nullMatcher instead of waiting for the attempt already
    // under way — the exact rescuer or report that triggered the wake-up is
    // told matching is unavailable, seconds before it comes back for everyone
    // after. Sharing the in-flight promise means every concurrent caller sees
    // the same outcome as the one that started it.
    if (pending) return pending;
    if (now - lastTry < RETRY_MS) return real || nullMatcher;
    lastTry = now;
    pending = (async () => {
      try {
        return await createMatcher();
      } catch (e) {
        console.error('[faces] init failed:', e.message);
        return nullMatcher;
      }
    })();
    try {
      real = await pending;
    } finally {
      pending = null;
    }
    return real;
  }

  return {
    get enabled() {
      return !!(real && real.enabled);
    },
    get status() {
      return (real && real.status) || 'sin inicializar';
    },
    async indexFace(bytes, externalId) {
      return (await get(Date.now())).indexFace(bytes, externalId);
    },
    async detectFace(bytes) {
      return (await get(Date.now())).detectFace(bytes);
    },
    async searchByImage(bytes) {
      return (await get(Date.now())).searchByImage(bytes);
    },
    async searchByFaceId(faceId) {
      return (await get(Date.now())).searchByFaceId(faceId);
    },
    async deleteFaces(faceIds) {
      return (await get(Date.now())).deleteFaces(faceIds);
    },
    async ensureReady() {
      return get(Date.now());
    }
  };
}

// La pregunta que todo llamador termina haciendo, de una u otra forma: "¿puedo
// hacer trabajo de reconocimiento facial ahora mismo?" (#89). El getter
// `enabled` de arriba es una trampa cuando el matcher es el lazy wrapper: es
// un valor cacheado sobre un objeto que puede no existir todavía, y leerlo
// antes de `ensureReady()` da `false` con Rekognition perfectamente
// disponible. Cada llamador reescribía el mismo par de líneas — despertar el
// matcher si sabe cómo, después leer `enabled` — con un guard `typeof`
// defensivo porque `nullMatcher` y los dobles de test no siempre implementan
// `ensureReady`. Este es ese par de líneas, escrito una sola vez.
//
// Sirve para las tres formas de matcher que este código recibe: el lazy
// wrapper de producción (necesita `ensureReady()` antes de que su respuesta
// signifique algo), el matcher real o `nullMatcher` (ya resueltos, responden
// al toque) y los dobles de test (no tienen inicialización perezosa que
// esperar, así que `ensureReady` sencillamente no existe en ellos).
async function matcherReady(matcher) {
  if (typeof matcher.ensureReady === 'function') await matcher.ensureReady();
  return !!matcher.enabled;
}

module.exports = { createMatcher, createLazyMatcher, nullMatcher, matcherReady };
