// =================================================================
// ÍNTEGRAMENTE — app.js definitivo
// Auditado línea por línea. Fixes vs. versión anterior:
//   · cargarMediaPipe(): import() dinámico (elimina race condition
//     del script CDN externo que nunca exponía FaceLandmarker a window)
//   · delegate: "CPU" (GPU falla silenciosamente en Android Chrome)
//   · enviarVideoYContinuar(): new File() con mime forzado a audio/webm,
//     validación de blob.size, timeout 30s con AbortController,
//     corta el flujo si no hay texto (no pasa con fallback genérico)
//   · enviarAudioYContinuar(): mismos fixes que video
//   · enviarADiagnostico(): timeout 45s, mensaje de error diferenciado
// =================================================================

// -----------------------------------------------------------------
// API_BASE: en producción el backend sirve el frontend desde el mismo
// dominio, así que /api resuelve directamente. En local apunta a 8000.
// -----------------------------------------------------------------
const API_BASE = (
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
) ? "http://localhost:8000/api" : "/api";

// -----------------------------------------------------------------
// ESTADO GLOBAL DE LA SESIÓN
// -----------------------------------------------------------------
const estado = {
  nombreUsuario: "",
  relatoTexto: "",
  metricasFaciales: null,
  dominioActual: "",
  herramientaActual: "",
  historialEjercicios: {
    Cuerpo:   { practica_guiada: 0, microaudio: 0, bitacora: 0 },
    Lenguaje: { practica_guiada: 0, microaudio: 0, bitacora: 0 },
    Emocion:  { practica_guiada: 0, microaudio: 0, bitacora: 0 },
  },
  ejercicioActualDetalle: null,
  eventosSesion: [],
  energiaActual: "baja",
};

const ETIQUETAS_DOMINIO    = { Cuerpo: "Cuerpo", Lenguaje: "Lenguaje", Emocion: "Emoción" };
const ETIQUETAS_HERRAMIENTA = {
  practica_guiada: "Práctica guiada",
  microaudio: "Microaudio",
  bitacora: "Tu bitácora",
};

function registrarEvento(texto) {
  estado.eventosSesion.push(texto);
}

// -----------------------------------------------------------------
// NAVEGACIÓN — con historial para el botón atrás global
// -----------------------------------------------------------------
const PANTALLAS_SIN_ATRAS = new Set(["pantalla-bienvenida"]);
const PANTALLAS_SIN_MENU  = new Set(["pantalla-bienvenida", "pantalla-registro", "pantalla-usuario-creado"]);
const historialPantallas = [];
let pantallaActualId = "pantalla-bienvenida";

function mostrarPantalla(id, opts = {}) {
  // FIX GENERAL: cualquier audio en curso se corta al cambiar de pantalla,
  // sin importar desde dónde se disparó (consigna, chat, meditación, etc.)
  if (reproductor && !reproductor.paused) reproductor.pause();
  if (id !== "pantalla-meditacion") detenerMusicaFondo();
  if (botonAudioActivo) {
    botonAudioActivo.textContent = textoOriginalBotonAudio;
    botonAudioActivo = null;
  }

  document.querySelectorAll(".pantalla").forEach(p => p.classList.remove("activa"));
  document.getElementById(id).classList.add("activa");
  window.scrollTo(0, 0);

  if (!opts.esVolver && id !== pantallaActualId) {
    historialPantallas.push(pantallaActualId);
  }
  pantallaActualId = id;

  const btnAtras = document.getElementById("btn-atras-global");
  if (btnAtras) {
    btnAtras.classList.toggle("oculto", PANTALLAS_SIN_ATRAS.has(id) || historialPantallas.length === 0);
  }
  const menuWrap = document.getElementById("menu-global-wrap");
  if (menuWrap) menuWrap.classList.toggle("oculto", PANTALLAS_SIN_MENU.has(id));
}

document.getElementById("btn-atras-global")?.addEventListener("click", () => {
  const anterior = historialPantallas.pop();
  if (anterior) mostrarPantalla(anterior, { esVolver: true });
});

// -----------------------------------------------------------------
// MENÚ GLOBAL — silenciador, métricas, reportes, finalizar sesión
// -----------------------------------------------------------------
let audioSilenciado = false;

document.getElementById("btn-menu-global")?.addEventListener("click", (e) => {
  e.stopPropagation();
  document.getElementById("menu-global-panel")?.classList.toggle("oculto");
});
document.addEventListener("click", () => {
  document.getElementById("menu-global-panel")?.classList.add("oculto");
});

document.getElementById("menu-item-silenciar")?.addEventListener("click", (e) => {
  audioSilenciado = !audioSilenciado;
  e.currentTarget.textContent = audioSilenciado ? "🔇 Activar audio" : "🔊 Silenciar audio";
  if (audioSilenciado && reproductor) reproductor.pause();
  document.getElementById("menu-global-panel")?.classList.add("oculto");
});

document.getElementById("menu-item-metricas")?.addEventListener("click", () => {
  document.getElementById("menu-global-panel")?.classList.add("oculto");
  renderizarMetricas();
  mostrarPantalla("pantalla-metricas");
});

document.getElementById("menu-item-reportes")?.addEventListener("click", () => {
  document.getElementById("menu-global-panel")?.classList.add("oculto");
  renderizarReportes();
  mostrarPantalla("pantalla-reportes");
});

document.getElementById("menu-item-finalizar")?.addEventListener("click", () => {
  document.getElementById("menu-global-panel")?.classList.add("oculto");
  mostrarPantalla("pantalla-ruteo");
});

// -----------------------------------------------------------------
// AUDIO: reproducir base64 con toggle pausa/reproducir
// -----------------------------------------------------------------
const reproductor = document.getElementById("reproductor-audio");
let botonAudioActivo = null;
let textoOriginalBotonAudio = "";

function reproducirAudioBase64(b64, botonOrigen) {
  if (!b64) {
    if (botonOrigen) {
      const t = botonOrigen.textContent;
      botonOrigen.textContent = "⚠️ Audio no disponible";
      setTimeout(() => { botonOrigen.textContent = t; }, 2200);
    }
    return;
  }

  if (botonOrigen === botonAudioActivo && !reproductor.paused) {
    reproductor.pause();
    botonOrigen.textContent = textoOriginalBotonAudio;
    botonAudioActivo = null;
    return;
  }

  if (botonAudioActivo && botonAudioActivo !== botonOrigen) {
    botonAudioActivo.textContent = textoOriginalBotonAudio;
  }

  reproductor.src = "data:audio/mpeg;base64," + b64;
  reproductor.play().then(() => {
    if (botonOrigen) {
      textoOriginalBotonAudio = botonOrigen.textContent;
      botonOrigen.textContent = "⏸️ Parar";
      botonAudioActivo = botonOrigen;
    }
  }).catch(() => {
    if (botonOrigen) {
      const t = botonOrigen.textContent;
      botonOrigen.textContent = "Tocá para escuchar";
      setTimeout(() => { botonOrigen.textContent = t; }, 2200);
    }
  });

  reproductor.onended = () => {
    if (botonAudioActivo) {
      botonAudioActivo.textContent = textoOriginalBotonAudio;
      botonAudioActivo = null;
    }
  };
}

// =================================================================
// PANTALLAS 1-2: BIENVENIDA Y REGISTRO
// =================================================================
let modoRegistro = true;

function obtenerUsuariosGuardados() {
  try { return JSON.parse(localStorage.getItem("integramente_usuarios") || "{}"); }
  catch (e) { return {}; }
}
function guardarUsuario(nombre, password) {
  const u = obtenerUsuariosGuardados();
  u[nombre.toLowerCase()] = password;
  localStorage.setItem("integramente_usuarios", JSON.stringify(u));
}

document.getElementById("btn-registrarse").addEventListener("click", () => {
  modoRegistro = true;
  document.getElementById("eyebrow-registro").textContent = "ÍNTEGRAMENTE";
  document.getElementById("titulo-registro").textContent = "Creemos tu espacio";
  document.getElementById("subtitulo-registro").textContent =
    "Comencemos a crear tu espacio privado, confidencial y de crecimiento.";
  document.getElementById("bloque-condiciones").classList.remove("oculto");
  document.getElementById("error-registro").classList.add("oculto");
  mostrarPantalla("pantalla-registro");
});

document.getElementById("btn-iniciar-sesion").addEventListener("click", () => {
  modoRegistro = false;
  document.getElementById("eyebrow-registro").textContent = "ÍNTEGRAMENTE";
  document.getElementById("titulo-registro").textContent = "Bienvenida/o de nuevo";
  document.getElementById("subtitulo-registro").textContent =
    "Ingresá tu nombre y contraseña para continuar.";
  document.getElementById("bloque-condiciones").classList.add("oculto");
  document.getElementById("error-registro").classList.add("oculto");
  mostrarPantalla("pantalla-registro");
});

document.getElementById("btn-confirmar-registro").addEventListener("click", () => {
  const nombre   = document.getElementById("input-nombre").value.trim();
  const password = document.getElementById("input-password").value.trim();
  const errorBox = document.getElementById("error-registro");

  if (!nombre || !password) {
    errorBox.textContent = "Completá tu nombre y contraseña para continuar.";
    errorBox.classList.remove("oculto"); return;
  }
  if (modoRegistro && !document.getElementById("check-condiciones").checked) {
    errorBox.textContent = "Necesitamos que confirmes que sos mayor de 18 años y aceptes las condiciones.";
    errorBox.classList.remove("oculto"); return;
  }
  errorBox.classList.add("oculto");

  const usuarios    = obtenerUsuariosGuardados();
  const claveUsuario = nombre.toLowerCase();

  if (modoRegistro) {
    if (usuarios[claveUsuario]) {
      errorBox.textContent = "Ya existe una cuenta con ese nombre. Probá iniciar sesión.";
      errorBox.classList.remove("oculto"); return;
    }
    guardarUsuario(nombre, password);
  } else {
    if (!usuarios[claveUsuario]) {
      errorBox.textContent = "No encontramos una cuenta con ese nombre. Probá registrarte primero.";
      errorBox.classList.remove("oculto"); return;
    }
    if (usuarios[claveUsuario] !== password) {
      errorBox.textContent = "La contraseña no coincide. Intentá de nuevo.";
      errorBox.classList.remove("oculto"); return;
    }
  }

  estado.nombreUsuario = nombre;
  document.getElementById("saludo-usuario").textContent = `Hola, ${nombre}`;
  registrarEvento(`Sesión iniciada por ${nombre}.`);
  if (!modoRegistro) mostrarSaludoConSesionAnterior();

  if (modoRegistro) {
    document.getElementById("dato-usuario-creado").textContent = nombre;
    const spanPwd    = document.getElementById("dato-password-creado");
    const btnMostrar = document.getElementById("btn-mostrar-password");
    spanPwd.textContent   = "•".repeat(password.length);
    spanPwd.dataset.real  = password;
    spanPwd.dataset.oculta = "true";
    btnMostrar.textContent = "Mostrar";
    mostrarPantalla("pantalla-usuario-creado");
  } else {
    mostrarPantalla("pantalla-canal");
  }
});

document.getElementById("btn-mostrar-password").addEventListener("click", (e) => {
  const span  = document.getElementById("dato-password-creado");
  const oculta = span.dataset.oculta === "true";
  span.textContent   = oculta ? span.dataset.real : "•".repeat(span.dataset.real.length);
  span.dataset.oculta = oculta ? "false" : "true";
  e.currentTarget.textContent = oculta ? "Ocultar" : "Mostrar";
});

document.getElementById("btn-ir-a-iniciar-sesion").addEventListener("click", () => {
  mostrarPantalla("pantalla-canal");
});

// =================================================================
// PANTALLA 3: ELECCIÓN DE CANAL
// =================================================================
document.querySelectorAll("#pantalla-canal .btn-circular").forEach(boton => {
  boton.addEventListener("click", () => {
    const canal = boton.dataset.canal;
    registrarEvento(`Canal elegido: ${canal}.`);
    if (canal === "video") {
      estadoBotonVideo = "listo";
      mostrarPantalla("pantalla-video");
      iniciarCamara();
    } else if (canal === "audio") {
      mostrarPantalla("pantalla-audio");
    } else {
      mostrarPantalla("pantalla-texto");
    }
  });
});

// =================================================================
// CANAL TEXTO
// =================================================================
const inputTexto      = document.getElementById("input-relato-texto");
const contadorPalabras = document.getElementById("contador-palabras");

inputTexto.addEventListener("input", () => {
  const palabras = inputTexto.value.trim().split(/\s+/).filter(Boolean);
  const cantidad = palabras.length;
  contadorPalabras.textContent = `${cantidad} / 500 palabras`;
  contadorPalabras.classList.toggle("limite", cantidad >= 500);
  if (cantidad > 500) inputTexto.value = palabras.slice(0, 500).join(" ");
});

document.getElementById("btn-enviar-texto").addEventListener("click", () => {
  const texto = inputTexto.value.trim();
  if (!texto) return;
  estado.relatoTexto    = texto;
  estado.metricasFaciales = null;
  registrarEvento("Relato recibido por texto.");
  enviarADiagnostico();
});

// =================================================================
// CANAL VIDEO: cámara + MediaPipe + MediaRecorder + transcripción
// =================================================================
let streamVideo           = null;
let grabandoVideo         = false;
let cronometroVideoId     = null;
let faceLandmarker        = null;
let poseLandmarker        = null;
let mediaPipeListo        = false;
let loopAnalisisActivo    = false;
let metricasAcumuladas    = [];
let metricasPosturaAcumuladas = [];
let reconocedorVozVideo   = null;
let mediaRecorderVideoAudio = null;
let chunksVideoAudio      = [];
let transcripcionVivaVideo = "";

function setBtnGrabarEstado(est) {
  const btn = document.getElementById("btn-grabar-video");
  if (!btn) return;
  switch (est) {
    case "cargando":   btn.textContent = "⏳ Cargando análisis facial..."; btn.disabled = true;  break;
    case "listo":      btn.textContent = "● Grabar";                       btn.disabled = false; break;
    case "grabando":   btn.textContent = "■ Parar grabación";              btn.disabled = false; break;
    case "procesando": btn.textContent = "⏳ Procesando...";               btn.disabled = true;  break;
    case "enviar":     btn.textContent = "✔ Enviar video";                 btn.disabled = false; break;
  }
}

async function iniciarCamara() {
  try {
    streamVideo = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById("video-preview").srcObject = streamVideo;
    document.getElementById("error-video").classList.add("oculto");
    setBtnGrabarEstado("cargando");
    await cargarMediaPipe();
    setBtnGrabarEstado("listo");
  } catch (e) {
    mostrarErrorCamara();
  }
}

function mostrarErrorCamara() {
  const eb = document.getElementById("error-video");
  eb.textContent = "No pudimos acceder a tu cámara o micrófono. Podés volver y elegir el canal de texto.";
  eb.classList.remove("oculto");
  setBtnGrabarEstado("listo");
}

// -----------------------------------------------------------------
// MediaPipe — import() DINÁMICO
// FIX CLAVE: en vez de depender de window.FaceLandmarker (que nunca
// estaba disponible por el race condition del script CDN externo),
// app.js importa MediaPipe él mismo con import() cuando lo necesita.
// Esto garantiza que FaceLandmarker y FilesetResolver estén disponibles
// sin importar el orden de carga de los scripts en el HTML.
// -----------------------------------------------------------------
async function cargarMediaPipe() {
  try {
    const vision = await import(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm"
    );
    const FaceLandmarker  = vision.FaceLandmarker;
    const PoseLandmarker  = vision.PoseLandmarker;
    const FilesetResolver = vision.FilesetResolver;

    if (!FaceLandmarker || !FilesetResolver) {
      console.warn("MediaPipe: FaceLandmarker no encontrado en el módulo ESM.");
      return;
    }

    const filesetResolver = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );

    // FIX: delegate CPU en vez de GPU.
    // GPU falla silenciosamente en la mayoría de Android Chrome,
    // dejando faceLandmarker en null sin lanzar ningún error visible.
    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "CPU",
      },
      outputFaceBlendshapes: true,
      runningMode: "VIDEO",
      numFaces: 1,
    });

    // Análisis de postura corporal (multimodal: rostro + cuerpo + lo que dice
    // la persona). Si falla, el flujo sigue funcionando solo con rostro + texto.
    try {
      if (PoseLandmarker) {
        poseLandmarker = await PoseLandmarker.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            delegate: "CPU",
          },
          runningMode: "VIDEO",
          numPoses: 1,
        });
        console.log("✅ MediaPipe Pose Landmarker listo (postura corporal)");
      }
    } catch (e) {
      console.warn("⚠️ Pose Landmarker no pudo cargarse, sigue solo con rostro:", e.message);
    }

    mediaPipeListo = true;

    if (!loopAnalisisActivo) {
      loopAnalisisActivo = true;
      requestAnimationFrame(analizarFrameVideo);
    }

    // El panel de detección se mantiene SIEMPRE oculto: el análisis
    // corre invisible por detrás, solo se usan las métricas en el diagnóstico.
    console.log("✅ MediaPipe Face Landmarker listo (CPU, Android-safe)");
  } catch (e) {
    // MediaPipe no pudo cargar (sin conexión, WebAssembly bloqueado, etc.)
    // El flujo continúa sin análisis facial — el botón se habilita igual.
    console.warn("⚠️ MediaPipe no pudo cargarse:", e.message);
  }
}

// Conexiones para la malla facial simplificada (subconjunto de 468 landmarks)
const CONEXIONES_CARA = [
  [10,338],[338,297],[297,332],[332,284],[284,251],[251,389],[389,356],
  [356,454],[454,323],[323,361],[361,288],[288,397],[397,365],[365,379],
  [379,378],[378,400],[400,377],[377,152],[152,148],[148,176],[176,149],
  [149,150],[150,136],[136,172],[172,58],[58,132],[132,93],[93,234],
  [234,127],[127,162],[162,21],[21,54],[54,103],[103,67],[67,109],[109,10],
  [46,53],[53,52],[52,65],[65,55],[55,70],[70,63],[63,105],[105,66],[66,107],[107,46],
  [276,283],[283,282],[282,295],[295,285],[285,300],[300,293],[293,334],[334,296],[296,336],[336,276],
  [33,160],[160,158],[158,133],[133,153],[153,144],[144,163],[163,7],[7,33],
  [263,387],[387,385],[385,362],[362,380],[380,373],[373,390],[390,249],[249,263],
  [168,6],[6,197],[197,195],[195,5],[5,4],[4,1],[1,19],[19,94],
  [94,2],[2,98],[98,97],[97,2],[2,326],[326,327],[327,294],
  [61,185],[185,40],[40,39],[39,37],[37,0],[0,267],[267,269],[269,270],[270,409],[409,291],
  [291,375],[375,321],[321,405],[405,314],[314,17],[17,84],[84,181],[181,91],[91,146],[146,61],
];

function dibujarLandmarksEnCanvas(faceLandmarks, expresionTexto, expresionColor) {
  const canvas = document.getElementById("canvas-facial");
  const video  = document.getElementById("video-preview");
  if (!canvas || !video || video.readyState < 2) return;

  const rect = video.getBoundingClientRect();
  const W = Math.round(rect.width);
  const H = Math.round(rect.height);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  if (!faceLandmarks || faceLandmarks.length === 0) return;
  const landmarks = faceLandmarks[0];

  ctx.fillStyle = "rgba(238,120,157,0.8)";
  for (const lm of landmarks) {
    ctx.beginPath();
    ctx.arc(lm.x * W, lm.y * H, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(218,39,107,0.5)";
  ctx.lineWidth = 1;
  for (const [a, b] of CONEXIONES_CARA) {
    if (!landmarks[a] || !landmarks[b]) continue;
    ctx.beginPath();
    ctx.moveTo(landmarks[a].x * W, landmarks[a].y * H);
    ctx.lineTo(landmarks[b].x * W, landmarks[b].y * H);
    ctx.stroke();
  }

  if (expresionTexto) {
    const pad = 12;
    ctx.font = "bold 13px 'Work Sans', Arial, sans-serif";
    const tw = ctx.measureText(expresionTexto).width + pad * 2;
    const th = 26;
    const rx = (W - tw) / 2;
    const ry = 10;
    ctx.fillStyle = expresionColor || "rgba(160,26,77,0.85)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(rx, ry, tw, th, 6);
    else ctx.rect(rx, ry, tw, th);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText(expresionTexto, W / 2, ry + th / 2);
  }
}

// Panel de demostración técnica — muestra métricas en vivo para la defensa
const ETIQUETAS_PARAMETROS_FACIALES = {
  browDownLeft:   "Ceja izquierda fruncida",
  browDownRight:  "Ceja derecha fruncida",
  mouthFrownLeft: "Comisura izquierda hacia abajo",
  mouthFrownRight:"Comisura derecha hacia abajo",
  mouthSmileLeft: "Sonrisa (lado izquierdo)",
  mouthSmileRight:"Sonrisa (lado derecho)",
  eyeSquintLeft:  "Ojo izquierdo entrecerrado",
  eyeSquintRight: "Ojo derecho entrecerrado",
};

function actualizarPanelFacial(vals) {
  // El panel ya no se muestra (análisis invisible). Solo devolvemos la
  // lectura para el overlay del canvas si hiciera falta en el futuro.
  Object.entries(ETIQUETAS_PARAMETROS_FACIALES).forEach(([k]) => {
    const pct   = Math.round((vals[k] || 0) * 100);
    const barra = document.getElementById(`barra-facial-${k}`);
    const num   = document.getElementById(`valor-facial-${k}`);
    if (barra) barra.style.width = `${pct}%`;
    if (num)   num.textContent   = `${pct}%`;
  });

  const ceja    = Math.max(vals.browDownLeft || 0,   vals.browDownRight || 0);
  const sonrisa = Math.max(vals.mouthSmileLeft || 0, vals.mouthSmileRight || 0);
  const frown   = Math.max(vals.mouthFrownLeft || 0, vals.mouthFrownRight || 0);

  let lectura = "Expresión neutra";
  if (sonrisa > 0.35) lectura = "Se detecta sonrisa";
  else if (ceja > 0.35 || frown > 0.35) lectura = "Se detecta gesto de tensión o seriedad";

  const lecturaEl = document.getElementById("lectura-facial-actual");
  if (lecturaEl) lecturaEl.textContent = lectura;

  let etiquetaCanvas, colorCanvas;
  if (sonrisa > 0.35) {
    etiquetaCanvas = "😊 Sonrisa detectada"; colorCanvas = "rgba(46,125,50,0.85)";
  } else if (ceja > 0.35 && frown > 0.25) {
    etiquetaCanvas = "😟 Tensión detectada"; colorCanvas = "rgba(160,26,77,0.85)";
  } else if (ceja > 0.35) {
    etiquetaCanvas = "🤔 Ceño fruncido";     colorCanvas = "rgba(93,60,0,0.85)";
  } else if (frown > 0.35) {
    etiquetaCanvas = "😔 Comisuras abajo";   colorCanvas = "rgba(105,26,56,0.85)";
  } else {
    etiquetaCanvas = "😐 Expresión neutra";  colorCanvas = "rgba(40,40,40,0.72)";
  }
  return { etiquetaCanvas, colorCanvas };
}

// -----------------------------------------------------------------
// POSTURA CORPORAL — deriva métricas simples de los 33 landmarks de
// MediaPipe Pose. Índices usados: 0 nariz, 7/8 orejas, 11/12 hombros,
// 15/16 muñecas, 23/24 caderas. Coordenadas normalizadas (0-1).
// -----------------------------------------------------------------
function calcularMetricasPostura(landmarks) {
  const nariz   = landmarks[0];
  const homI    = landmarks[11], homD = landmarks[12];
  const munI    = landmarks[15], munD = landmarks[16];
  const cadI    = landmarks[23], cadD = landmarks[24];
  if (!nariz || !homI || !homD || !cadI || !cadD) return null;

  const homMedioX = (homI.x + homD.x) / 2;
  const homMedioY = (homI.y + homD.y) / 2;
  const cadMedioX = (cadI.x + cadD.x) / 2;
  const cadMedioY = (cadI.y + cadD.y) / 2;

  const anchoHombros = Math.max(Math.abs(homI.x - homD.x), 0.05);
  const altoTorso    = Math.max(Math.abs(homMedioY - cadMedioY), 0.05);

  // Cabeza caída / mirando hacia abajo: poca distancia vertical nariz-hombros
  const cabezaCaida = 1 - Math.min(Math.abs(homMedioY - nariz.y) / anchoHombros, 1.5) / 1.5;
  // Hombros desnivelados (tensión / asimetría)
  const hombrosAsimetricos = Math.min(Math.abs(homI.y - homD.y) / anchoHombros, 1);
  // Torso inclinado hacia un costado
  const torsoInclinado = Math.min(Math.abs(homMedioX - cadMedioX) / altoTorso, 1);
  // Apertura corporal: brazos abiertos (alto) vs cerrados/cruzados (bajo)
  let aperturaCorporal = 0.5;
  if (munI && munD) {
    const distMunecas = Math.hypot(munI.x - munD.x, munI.y - munD.y);
    aperturaCorporal = Math.min(distMunecas / (anchoHombros * 2), 1);
  }

  return {
    cabezaCaida:        +cabezaCaida.toFixed(3),
    hombrosAsimetricos: +hombrosAsimetricos.toFixed(3),
    torsoInclinado:     +torsoInclinado.toFixed(3),
    aperturaCorporal:   +aperturaCorporal.toFixed(3),
  };
}

function resumirMetricasPostura() {
  if (metricasPosturaAcumuladas.length === 0) return null;
  const prom = {};
  const claves = Object.keys(metricasPosturaAcumuladas[0]);
  claves.forEach(k => {
    const suma = metricasPosturaAcumuladas.reduce((acc, m) => acc + (m[k] || 0), 0);
    prom[k] = +(suma / metricasPosturaAcumuladas.length).toFixed(3);
  });
  return prom;
}

function analizarFrameVideo() {
  const activa = document.getElementById("pantalla-video").classList.contains("activa");
  if (!activa) { loopAnalisisActivo = false; return; }

  requestAnimationFrame(analizarFrameVideo);
  if (!faceLandmarker || !mediaPipeListo) return;

  const video = document.getElementById("video-preview");
  if (!video || video.readyState < 2 || video.paused || video.ended) return;

  let resultado;
  try { resultado = faceLandmarker.detectForVideo(video, performance.now()); }
  catch (e) { return; }

  if (resultado.faceBlendshapes && resultado.faceBlendshapes.length > 0) {
    const shapes = resultado.faceBlendshapes[0].categories;
    const claves = Object.keys(ETIQUETAS_PARAMETROS_FACIALES);
    const vals   = Object.fromEntries(
      shapes.filter(s => claves.includes(s.categoryName))
            .map(s => [s.categoryName, s.score])
    );
    const { etiquetaCanvas, colorCanvas } = actualizarPanelFacial(vals);
    dibujarLandmarksEnCanvas(resultado.faceLandmarks, etiquetaCanvas, colorCanvas);
    if (grabandoVideo) metricasAcumuladas.push(vals);
  } else {
    limpiarCanvas();
  }

  // Postura corporal — corre en paralelo, invisible, solo si el modelo cargó
  if (poseLandmarker && grabandoVideo) {
    try {
      const resultadoPose = poseLandmarker.detectForVideo(video, performance.now());
      if (resultadoPose.landmarks && resultadoPose.landmarks.length > 0) {
        const metricasPostura = calcularMetricasPostura(resultadoPose.landmarks[0]);
        if (metricasPostura) metricasPosturaAcumuladas.push(metricasPostura);
      }
    } catch (e) { /* frame descartado, sigue el análisis facial igual */ }
  }
}

function limpiarCanvas() {
  const c = document.getElementById("canvas-facial");
  if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
}

function resumirMetricasFaciales() {
  if (metricasAcumuladas.length === 0) return null;
  const prom = {};
  const claves = Object.keys(metricasAcumuladas[0]);
  claves.forEach(k => {
    const suma = metricasAcumuladas.reduce((acc, m) => acc + (m[k] || 0), 0);
    prom[k] = +(suma / metricasAcumuladas.length).toFixed(3);
  });
  return prom;
}

// -----------------------------------------------------------------
// Botón de grabación de video — máquina de estados explícita
// listo → grabando → procesando → listo_para_enviar → (envía)
// -----------------------------------------------------------------
let estadoBotonVideo = "listo";

document.getElementById("btn-grabar-video").addEventListener("click", async () => {
  if (estadoBotonVideo === "listo") {
    estadoBotonVideo = "grabando";
    iniciarGrabacionVideo();
  } else if (estadoBotonVideo === "grabando") {
    estadoBotonVideo = "procesando";
    setBtnGrabarEstado("procesando");
    await detenerGrabacionVideo();
    estadoBotonVideo = "listo_para_enviar";
    setBtnGrabarEstado("enviar");
  } else if (estadoBotonVideo === "listo_para_enviar") {
    estadoBotonVideo = "enviando";
    await enviarVideoYContinuar();
  }
});

function iniciarGrabacionVideo() {
  if (!streamVideo) return mostrarErrorCamara();
  grabandoVideo      = true;
  metricasAcumuladas = [];
  metricasPosturaAcumuladas = [];
  chunksVideoAudio   = [];
  transcripcionVivaVideo = "";

  setBtnGrabarEstado("grabando");
  document.getElementById("cronometro-video").classList.add("activo");

  // Grabar audio del stream para transcripción por Gemini
  try {
    const audioStream = new MediaStream(streamVideo.getAudioTracks());
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
        ? "audio/ogg;codecs=opus"
        : "audio/webm";
    mediaRecorderVideoAudio = new MediaRecorder(audioStream, { mimeType });
    mediaRecorderVideoAudio.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksVideoAudio.push(e.data);
    };
    mediaRecorderVideoAudio.start(200);
  } catch (e) {
    console.warn("MediaRecorder de video no pudo iniciarse:", e);
  }

  // Subtítulos en vivo (visual only — la transcripción real viene del backend)
  iniciarTranscripcionVozEnVivo((txt) => { transcripcionVivaVideo = txt; });

  let segundos = 60;
  actualizarCronometro("cronometro-video", segundos);
  cronometroVideoId = setInterval(() => {
    segundos--;
    actualizarCronometro("cronometro-video", segundos);
    if (segundos <= 0) {
      clearInterval(cronometroVideoId);
      if (estadoBotonVideo === "grabando") {
        estadoBotonVideo = "procesando";
        setBtnGrabarEstado("procesando");
        detenerGrabacionVideo().then(() => {
          estadoBotonVideo = "listo_para_enviar";
          setBtnGrabarEstado("enviar");
        });
      }
    }
  }, 1000);
}

function detenerGrabacionVideo() {
  return new Promise((resolve) => {
    grabandoVideo = false;
    clearInterval(cronometroVideoId);
    document.getElementById("cronometro-video").classList.remove("activo");
    detenerTranscripcionVozEnVivo();
    if (mediaRecorderVideoAudio && mediaRecorderVideoAudio.state !== "inactive") {
      mediaRecorderVideoAudio.onstop = () => resolve();
      mediaRecorderVideoAudio.stop();
    } else {
      resolve();
    }
  });
}

async function enviarVideoYContinuar() {
  setBtnGrabarEstado("procesando");
  document.getElementById("btn-grabar-video").textContent = "⏳ Transcribiendo...";

  loopAnalisisActivo = false;
  limpiarCanvas();
  mediaPipeListo = false;
  faceLandmarker = null;
  poseLandmarker = null;

  const subtituloEl = document.getElementById("subtitulo-voz-live");
  if (subtituloEl) subtituloEl.classList.add("oculto");
  const panel = document.getElementById("panel-deteccion-facial");
  if (panel) panel.classList.add("oculto");

  const errorBox = document.getElementById("error-video");
  if (errorBox) errorBox.classList.add("oculto");

  let textoTranscripto = "";

  if (chunksVideoAudio.length > 0) {
    const mimeType = (mediaRecorderVideoAudio?.mimeType) || "audio/webm";
    const blob     = new Blob(chunksVideoAudio, { type: mimeType });
    console.log(`📤 Audio video: ${blob.size} bytes`);

    if (blob.size >= 500) {
      try {
        const form = new FormData();
        // FIX: new File() con type forzado a audio/webm.
        // Android Chrome envía application/octet-stream si usamos blob directo,
        // y Gemini rechaza ese mime silenciosamente devolviendo texto vacío.
        form.append("audio", new File([blob], "grabacion.webm", { type: "audio/webm" }), "grabacion.webm");

        const ctrl     = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), 30000);
        const resp     = await fetch(`${API_BASE}/transcribir`, {
          method: "POST", body: form, signal: ctrl.signal,
        });
        clearTimeout(timeoutId);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        textoTranscripto = ((await resp.json()).texto || "").trim();
        console.log(`✅ Transcripción video: "${textoTranscripto.slice(0, 80)}"`);
      } catch (e) {
        console.warn("⚠️ Error transcribiendo audio de video:", e.name, e.message);
      }
    }
  }

  // Detener cámara
  if (streamVideo) {
    streamVideo.getTracks().forEach(t => t.stop());
    streamVideo = null;
  }

  // FIX: si no hay texto de ninguna fuente, NO pasamos al diagnóstico
  // con el fallback genérico — eso generaba siempre la misma respuesta.
  const textoFinal = textoTranscripto || transcripcionVivaVideo || "";
  if (!textoFinal) {
    if (errorBox) {
      errorBox.textContent = "No pudimos escuchar tu grabación. Verificá que el micrófono esté habilitado en tu navegador o usá el canal de texto.";
      errorBox.classList.remove("oculto");
    }
    estadoBotonVideo = "listo";
    setBtnGrabarEstado("listo");
    return;
  }

  estado.relatoTexto    = textoFinal;
  estado.metricasFaciales = {
    facial:  resumirMetricasFaciales(),
    postura: resumirMetricasPostura(),
  };
  registrarEvento("Relato recibido por video, con análisis de expresión facial, postura corporal y transcripción de voz.");
  enviarADiagnostico();
}

function actualizarCronometro(id, seg) {
  const m = String(Math.floor(seg / 60)).padStart(2, "0");
  const s = String(seg % 60).padStart(2, "0");
  document.getElementById(id).textContent = `${m}:${s}`;
}

// =================================================================
// CANAL AUDIO: MediaRecorder + transcripción por Gemini en backend
// =================================================================
let grabandoAudio         = false;
let cronometroAudioId     = null;
let mediaRecorderAudio    = null;
let chunksAudio           = [];
let estadoBotonAudio      = "listo";

document.getElementById("btn-grabar-audio").addEventListener("click", async () => {
  if (estadoBotonAudio === "listo") {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      iniciarGrabacionAudio(stream);
      estadoBotonAudio = "grabando";
    } catch (e) {
      const eb = document.getElementById("error-audio");
      eb.textContent = "No pudimos acceder a tu micrófono. Podés volver y elegir el canal de texto.";
      eb.classList.remove("oculto");
    }
  } else if (estadoBotonAudio === "grabando") {
    estadoBotonAudio = "procesando";
    setBtnAudioEstado("procesando");
    await detenerGrabacionAudio();
    estadoBotonAudio = "listo_para_enviar";
    setBtnAudioEstado("enviar");
  } else if (estadoBotonAudio === "listo_para_enviar") {
    estadoBotonAudio = "enviando";
    await enviarAudioYContinuar();
  }
});

function setBtnAudioEstado(est) {
  const btn = document.getElementById("btn-grabar-audio");
  switch (est) {
    case "listo":      btn.textContent = "● Grabar";          btn.disabled = false; break;
    case "grabando":   btn.textContent = "■ Parar grabación"; btn.disabled = false; break;
    case "procesando": btn.textContent = "⏳ Procesando...";  btn.disabled = true;  break;
    case "enviar":     btn.textContent = "✔ Enviar audio";    btn.disabled = false; break;
  }
}

function iniciarGrabacionAudio(stream) {
  grabandoAudio  = true;
  chunksAudio    = [];
  document.getElementById("ondas-audio").classList.remove("oculto");
  document.getElementById("cronometro-audio").classList.add("activo");
  setBtnAudioEstado("grabando");

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
      ? "audio/ogg;codecs=opus"
      : "audio/webm";

  mediaRecorderAudio = new MediaRecorder(stream, { mimeType });
  mediaRecorderAudio.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunksAudio.push(e.data);
  };
  mediaRecorderAudio.start(200);

  let segundos = 60;
  actualizarCronometro("cronometro-audio", segundos);
  cronometroAudioId = setInterval(() => {
    segundos--;
    actualizarCronometro("cronometro-audio", segundos);
    if (segundos <= 0) {
      clearInterval(cronometroAudioId);
      if (estadoBotonAudio === "grabando") {
        estadoBotonAudio = "procesando";
        setBtnAudioEstado("procesando");
        detenerGrabacionAudio().then(() => {
          estadoBotonAudio = "listo_para_enviar";
          setBtnAudioEstado("enviar");
        });
      }
    }
  }, 1000);
}

function detenerGrabacionAudio() {
  return new Promise((resolve) => {
    grabandoAudio = false;
    clearInterval(cronometroAudioId);
    document.getElementById("ondas-audio").classList.add("oculto");
    document.getElementById("cronometro-audio").classList.remove("activo");
    if (!mediaRecorderAudio || mediaRecorderAudio.state === "inactive") { resolve(); return; }
    mediaRecorderAudio.onstop = () => resolve();
    mediaRecorderAudio.stop();
    if (mediaRecorderAudio.stream) {
      mediaRecorderAudio.stream.getTracks().forEach(t => t.stop());
    }
  });
}

async function enviarAudioYContinuar() {
  const btn    = document.getElementById("btn-grabar-audio");
  const errorBox = document.getElementById("error-audio");
  btn.textContent = "⏳ Transcribiendo...";
  btn.disabled    = true;
  if (errorBox) errorBox.classList.add("oculto");

  const mimeType = (mediaRecorderAudio?.mimeType) || "audio/webm";
  const blob     = new Blob(chunksAudio, { type: mimeType });
  console.log(`📤 Audio: ${blob.size} bytes`);

  if (blob.size < 500) {
    if (errorBox) {
      errorBox.textContent = "No se detectó audio. Verificá que el micrófono esté habilitado en tu navegador.";
      errorBox.classList.remove("oculto");
    }
    setBtnAudioEstado("listo");
    estadoBotonAudio = "listo";
    return;
  }

  let textoTranscripto = "";
  try {
    const form = new FormData();
    // FIX: mismo fix que video — new File() con mime forzado a audio/webm
    form.append("audio", new File([blob], "grabacion.webm", { type: "audio/webm" }), "grabacion.webm");

    const ctrl      = new AbortController();
    const timeoutId  = setTimeout(() => ctrl.abort(), 30000);
    const resp      = await fetch(`${API_BASE}/transcribir`, {
      method: "POST", body: form, signal: ctrl.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    textoTranscripto = ((await resp.json()).texto || "").trim();
    console.log(`✅ Transcripción audio: "${textoTranscripto.slice(0, 80)}"`);
  } catch (e) {
    console.warn("⚠️ Error transcribiendo audio:", e.name, e.message);
  }

  setBtnAudioEstado("listo");

  // FIX: no pasar con texto vacío
  if (!textoTranscripto) {
    if (errorBox) {
      errorBox.textContent = "No pudimos escuchar tu grabación. Intentá de nuevo o usá el canal de texto.";
      errorBox.classList.remove("oculto");
    }
    estadoBotonAudio = "listo";
    return;
  }

  estado.relatoTexto    = textoTranscripto;
  estado.metricasFaciales = null;
  registrarEvento("Relato recibido por audio (transcripto por Gemini).");
  enviarADiagnostico();
}

// =================================================================
// Subtítulos en vivo del video (visual only — no es la transcripción final)
// =================================================================
let transcripcionActiva = false;
let onResultadoActual   = null;

function iniciarTranscripcionVozEnVivo(onResultado) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  transcripcionActiva = true;
  onResultadoActual   = onResultado;
  let transcripcionFinal = "";
  const subtituloEl = document.getElementById("subtitulo-voz-live");

  function crearYArrancar() {
    if (!transcripcionActiva) return;
    reconocedorVozVideo = new SR();
    reconocedorVozVideo.lang = "es-AR";
    reconocedorVozVideo.continuous = true;
    reconocedorVozVideo.interimResults = true;

    reconocedorVozVideo.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) transcripcionFinal += t + " ";
        else interim += t;
      }
      const completo = (transcripcionFinal + interim).trim();
      if (onResultadoActual) onResultadoActual(completo);
      if (subtituloEl) {
        const ultimas = completo.split(/\s+/).filter(Boolean).slice(-12).join(" ");
        subtituloEl.textContent = ultimas;
        subtituloEl.classList.toggle("oculto", !ultimas);
      }
    };
    reconocedorVozVideo.onerror = () => {};
    reconocedorVozVideo.onend   = () => {
      if (transcripcionActiva) crearYArrancar();
      else if (subtituloEl) subtituloEl.classList.add("oculto");
    };
    try { reconocedorVozVideo.start(); } catch (e) {}
  }
  crearYArrancar();
}

function detenerTranscripcionVozEnVivo() {
  transcripcionActiva = false;
  if (reconocedorVozVideo) {
    try { reconocedorVozVideo.stop(); } catch (e) {}
    reconocedorVozVideo = null;
  }
  const subtituloEl = document.getElementById("subtitulo-voz-live");
  if (subtituloEl) subtituloEl.classList.add("oculto");
}

// =================================================================
// PANTALLA 5: ENVIAR A DIAGNÓSTICO
// =================================================================
async function enviarADiagnostico() {
  mostrarPantalla("pantalla-analisis");

  console.log(`📤 Diagnóstico — relato: "${estado.relatoTexto.slice(0, 80)}" | métricas: ${estado.metricasFaciales ? "sí" : "no"}`);

  const form = new FormData();
  form.append("relato_texto",    estado.relatoTexto);
  form.append("metricas_faciales", estado.metricasFaciales
    ? JSON.stringify(estado.metricasFaciales)
    : "");

  try {
    const ctrl      = new AbortController();
    const timeoutId  = setTimeout(() => ctrl.abort(), 45000);
    const resp      = await fetch(`${API_BASE}/diagnostico`, {
      method: "POST", body: form, signal: ctrl.signal,
    });
    clearTimeout(timeoutId);

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    console.log(`✅ Diagnóstico: "${data.texto.slice(0, 80)}"`);
    estado.energiaActual = data.energia || "baja";
    document.getElementById("texto-diagnostico").textContent = data.texto;
    registrarEvento(`Diagnóstico: ${data.texto}`);
    document.getElementById("btn-reproducir-diagnostico").onclick =
      (e) => reproducirAudioBase64(data.audio_base64, e.currentTarget);
    mostrarPantalla("pantalla-devolucion");

  } catch (e) {
    console.warn("⚠️ Error en diagnóstico:", e.name, e.message);
    const msgError = e.name === "AbortError"
      ? "El servidor tardó demasiado en responder. Render puede estar iniciando (hasta 60 seg la primera vez). Volvé a intentarlo."
      : `No pudimos conectar con el servidor. (${e.message})`;
    document.getElementById("texto-diagnostico").textContent = msgError;
    document.getElementById("btn-reproducir-diagnostico").onclick =
      (e) => reproducirAudioBase64("", e.currentTarget);
    mostrarPantalla("pantalla-devolucion");
  }
}

// =================================================================
// PANTALLA 6: ELECCIÓN DE DOMINIO
// =================================================================
document.querySelectorAll("#pantalla-devolucion .btn-circular").forEach(boton => {
  boton.addEventListener("click", () => {
    estado.dominioActual = boton.dataset.dominio;
    registrarEvento(`Dominio elegido: ${estado.dominioActual}.`);
    mostrarPantallaHerramientas();
  });
});

function mostrarPantallaHerramientas() {
  document.getElementById("eyebrow-dominio").textContent    = ETIQUETAS_DOMINIO[estado.dominioActual];
  document.getElementById("titulo-herramientas").textContent =
    `Elegiste trabajar tu ${ETIQUETAS_DOMINIO[estado.dominioActual].toLowerCase()}`;
  document.getElementById("subtitulo-herramientas").textContent =
    "Elegí qué herramienta querés utilizar para acompañar este momento.";
  mostrarPantalla("pantalla-herramientas");
}

// =================================================================
// PANTALLA 7: ELECCIÓN DE HERRAMIENTA
// =================================================================
document.querySelectorAll(".tarjeta-herramienta").forEach(tarjeta => {
  tarjeta.addEventListener("click", () => {
    estado.herramientaActual = tarjeta.dataset.herramienta;
    registrarEvento(`Herramienta elegida: ${ETIQUETAS_HERRAMIENTA[estado.herramientaActual]}.`);
    if (estado.herramientaActual === "microaudio") {
      pedirMeditacion();
    } else {
      pedirEjercicio();
    }
  });
});

document.getElementById("btn-finalizar-desde-herramientas").addEventListener("click", () => {
  mostrarPantalla("pantalla-reporte");
});

// =================================================================
// PANTALLA 8: EJERCICIO
// =================================================================
async function pedirEjercicio() {
  mostrarPantalla("pantalla-analisis");
  const variante = estado.historialEjercicios[estado.dominioActual][estado.herramientaActual];

  const form = new FormData();
  form.append("dominio",       estado.dominioActual);
  form.append("herramienta",   estado.herramientaActual);
  form.append("relato_texto",  estado.relatoTexto);
  form.append("variante_idx",  variante);

  let data;
  try {
    const resp = await fetch(`${API_BASE}/ejercicio`, { method: "POST", body: form });
    data = await resp.json();
  } catch (e) {
    data = {
      consigna:  "Te invitamos a habitar este ejercicio con presencia.",
      fundamento: "Validamos este espacio de estructura y transformación.",
      audio_consigna_base64: "", audio_fundamento_base64: "",
    };
  }

  estado.historialEjercicios[estado.dominioActual][estado.herramientaActual]++;
  estado.ejercicioActualDetalle = data;
  registrarEvento(`Ejercicio ejecutado: ${data.consigna}`);

  document.getElementById("eyebrow-ejercicio").textContent =
    `Ejercicio en curso: ${ETIQUETAS_DOMINIO[estado.dominioActual]} — ${ETIQUETAS_HERRAMIENTA[estado.herramientaActual]}`;
  document.getElementById("texto-consigna").textContent = data.consigna;
  document.getElementById("btn-reproducir-consigna").onclick =
    (e) => reproducirAudioBase64(data.audio_consigna_base64, e.currentTarget);

  configurarRenderEjercicio(variante);
  mostrarPantalla("pantalla-ejercicio");

  // FIX: antes había que tocar un botón para escuchar la consigna;
  // ahora se reproduce sola al entrar, como corresponde a una guía hablada.
  if (data.audio_consigna_base64 && !audioSilenciado) {
    reproducirAudioBase64(data.audio_consigna_base64, document.getElementById("btn-reproducir-consigna"));
  }
}

function configurarRenderEjercicio(variante) {
  document.getElementById("bloque-respiracion").classList.add("oculto");
  document.getElementById("bloque-bitacora").classList.add("oculto");
  document.getElementById("bloque-espera-simple").classList.add("oculto");

  if (estado.herramientaActual === "practica_guiada" && variante % 2 === 0) {
    document.getElementById("bloque-respiracion").classList.remove("oculto");
    animarRespiracion();
  } else if (estado.herramientaActual === "bitacora") {
    document.getElementById("bloque-bitacora").classList.remove("oculto");
    document.getElementById("input-bitacora").value = "";
  } else {
    document.getElementById("bloque-espera-simple").classList.remove("oculto");
  }
}

let cicloRespiracionId = null;
function animarRespiracion() {
  const circulo = document.getElementById("circulo-respiracion");
  const texto   = document.getElementById("texto-fase-respiracion");
  const fases   = [
    { clase: "inhalar",  texto: "Inhalá"  },
    { clase: "sostener", texto: "Sostené" },
    { clase: "exhalar",  texto: "Exhalá"  },
  ];
  let i = 0;
  clearInterval(cicloRespiracionId);
  function paso() {
    circulo.className   = "circulo-respiracion " + fases[i].clase;
    circulo.textContent = fases[i].texto;
    texto.textContent   = `${fases[i].texto} (4 segundos)`;
    i = (i + 1) % fases.length;
  }
  paso();
  cicloRespiracionId = setInterval(paso, 4000);
}

document.getElementById("btn-continuar-ejercicio").addEventListener("click", () => {
  clearInterval(cicloRespiracionId);
  if (estado.herramientaActual === "bitacora") {
    const txt = document.getElementById("input-bitacora").value.trim();
    if (txt) registrarEvento(`Registro de bitácora: "${txt}"`);
  }
  const data = estado.ejercicioActualDetalle;
  document.getElementById("texto-fundamento").textContent = data.fundamento;
  document.getElementById("btn-reproducir-fundamento").onclick =
    (e) => reproducirAudioBase64(data.audio_fundamento_base64, e.currentTarget);

  const tarjetaMantra = document.getElementById("tarjeta-mantra");
  if (data.mantra) {
    document.getElementById("texto-mantra").textContent = data.mantra;
    document.getElementById("texto-mantra-explicacion").textContent = data.mantra_explicacion || "";
    document.getElementById("btn-reproducir-mantra").onclick =
      (e) => reproducirAudioBase64(data.audio_mantra_base64, e.currentTarget);
    tarjetaMantra.classList.remove("oculto");
  } else {
    tarjetaMantra.classList.add("oculto");
  }

  registrarEvento(`Devolución: ${data.fundamento}`);
  mostrarPantalla("pantalla-fundamento");
});

// =================================================================
// PANTALLA 9→8c: DE LA DEVOLUCIÓN DEL EJERCICIO A LA CHARLA
// =================================================================
document.getElementById("btn-continuar-a-ruteo").addEventListener("click", () => {
  iniciarChatConversacional();
});

// =================================================================
// PANTALLA 10: RUTEO
// =================================================================

document.getElementById("btn-ruteo-herramienta").addEventListener("click", () => {
  registrarEvento("Elige probar otra herramienta en el mismo dominio.");
  mostrarPantallaHerramientas();
});
document.getElementById("btn-ruteo-dominio").addEventListener("click", () => {
  registrarEvento("Elige cambiar de dominio.");
  mostrarPantalla("pantalla-devolucion");
});
document.getElementById("btn-ruteo-finalizar").addEventListener("click", () =>
  mostrarPantalla("pantalla-reporte"));

// =================================================================
// PANTALLA 11: REPORTE Y DESPEDIDA
// =================================================================
document.getElementById("btn-descargar-reporte").addEventListener("click", async () => {
  const boton = document.getElementById("btn-descargar-reporte");
  const textoOriginal = boton.textContent;
  boton.textContent = "Generando reporte...";
  boton.disabled    = true;

  const form = new FormData();
  form.append("nombre_usuario", estado.nombreUsuario);
  form.append("eventos_json",   JSON.stringify(estado.eventosSesion));

  try {
    const resp = await fetch(`${API_BASE}/reporte`, { method: "POST", body: form });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const url  = window.URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = "Integramente_Reporte_Sesion.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    guardarReporteEnLocalStorage();
  } catch (e) {
    console.warn("Error generando reporte:", e);
    boton.textContent = textoOriginal;
    boton.disabled    = false;
    alert("No pudimos generar el reporte. Verificá la conexión o que el servidor esté activo.");
    return;
  }

  boton.textContent = textoOriginal;
  boton.disabled    = false;
  mostrarPantalla("pantalla-despedida");
});

document.getElementById("btn-sin-reporte").addEventListener("click", () =>
  mostrarPantalla("pantalla-despedida"));

document.getElementById("btn-nueva-sesion").addEventListener("click", () => {
  estado.relatoTexto     = "";
  estado.metricasFaciales = null;
  estado.dominioActual   = "";
  estado.herramientaActual = "";
  estado.eventosSesion   = [];
  Object.keys(estado.historialEjercicios).forEach(d => {
    Object.keys(estado.historialEjercicios[d]).forEach(h => {
      estado.historialEjercicios[d][h] = 0;
    });
  });
  mostrarPantalla("pantalla-canal");
});

// =================================================================
// MEDITACIÓN GUIADA POR PASOS — sin botón "siguiente", avanza sola
// =================================================================
// -----------------------------------------------------------------
// MÚSICA DE FONDO — solo durante la meditación, a bajo volumen.
// Los 6 archivos van en app/frontend/static/sonidos/, con estos nombres
// exactos (fondo-1.mp3 ... fondo-6.mp3). Si un archivo no existe todavía,
// simplemente no suena música, pero la meditación funciona igual.
// -----------------------------------------------------------------
const MUSICA_FONDO = [
  "/static/sonidos/fondo-1.mp3", "/static/sonidos/fondo-2.mp3", "/static/sonidos/fondo-3.mp3",
  "/static/sonidos/fondo-4.mp3", "/static/sonidos/fondo-5.mp3", "/static/sonidos/fondo-6.mp3",
  "/static/sonidos/fondo-7.mp3",
];
const musicaFondoEl = document.getElementById("musica-fondo");

function iniciarMusicaFondo() {
  if (!musicaFondoEl || audioSilenciado) return;
  const pista = MUSICA_FONDO[Math.floor(Math.random() * MUSICA_FONDO.length)];
  musicaFondoEl.src = pista;
  musicaFondoEl.volume = 0.15;
  musicaFondoEl.play().catch(() => { /* si el archivo no existe todavía, no pasa nada */ });
}

function detenerMusicaFondo() {
  if (!musicaFondoEl) return;
  musicaFondoEl.pause();
  musicaFondoEl.currentTime = 0;
}

let pasosMeditacion = [];
let audiosMeditacion = [];
let indicePasoMeditacion = 0;
let timerMeditacionId = null;
let preguntaCierreMeditacion = "";

async function pedirMeditacion() {
  mostrarPantalla("pantalla-analisis");

  const form = new FormData();
  form.append("dominio", estado.dominioActual);
  form.append("herramienta", estado.herramientaActual);
  form.append("relato_texto", estado.relatoTexto);
  form.append("energia", estado.energiaActual || "baja");

  let data;
  try {
    const resp = await fetch(`${API_BASE}/meditacion`, { method: "POST", body: form });
    data = await resp.json();
  } catch (e) {
    data = {
      intro: "Te invito a hacer una pausa. Este momento es tuyo.",
      pasos: [{ texto: "Respirá hondo y soltá el aire despacio.", pausa_seg: 6 }],
      pregunta_cierre: "¿Cómo te quedaste? ¿Qué notás ahora?",
      categoria: "pausa",
      audio_intro_base64: "", audios_pasos_base64: [""], audio_pregunta_base64: "",
    };
  }

  estado.categoriaAnimoActual = data.categoria || "pausa";

  pasosMeditacion = data.pasos || [];
  audiosMeditacion = data.audios_pasos_base64 || [];
  preguntaCierreMeditacion = data.pregunta_cierre || "¿Cómo te quedaste con esto?";
  indicePasoMeditacion = -1;

  document.getElementById("eyebrow-meditacion").textContent =
    `${ETIQUETAS_DOMINIO[estado.dominioActual]} — Meditación guiada`;

  registrarEvento(`Meditación iniciada: ${data.intro || ""}`);
  pintarPuntosMeditacion();
  mostrarPantalla("pantalla-meditacion");
  iniciarMusicaFondo();

  const textoEl = document.getElementById("meditacion-texto-paso");
  textoEl.textContent = data.intro || "Empecemos.";
  if (data.audio_intro_base64 && !audioSilenciado) {
    reproducirAudioAutomatico(data.audio_intro_base64, () => avanzarPasoMeditacion());
  } else {
    timerMeditacionId = setTimeout(avanzarPasoMeditacion, 2500);
  }
}

function pintarPuntosMeditacion() {
  const cont = document.getElementById("meditacion-puntos");
  if (!cont) return;
  cont.innerHTML = "";
  pasosMeditacion.forEach((_, i) => {
    const p = document.createElement("span");
    p.className = "meditacion-punto" + (i === indicePasoMeditacion ? " activo" : "");
    cont.appendChild(p);
  });
}

function reproducirAudioAutomatico(b64, alTerminar) {
  if (!b64) { alTerminar(); return; }
  reproductor.onended = alTerminar;
  reproductor.onerror = alTerminar;
  reproductor.src = "data:audio/mpeg;base64," + b64;
  reproductor.play().catch(alTerminar);
}

function avanzarPasoMeditacion() {
  clearTimeout(timerMeditacionId);
  indicePasoMeditacion++;
  pintarPuntosMeditacion();

  const circulo = document.getElementById("meditacion-circulo");
  const textoEl = document.getElementById("meditacion-texto-paso");

  if (indicePasoMeditacion >= pasosMeditacion.length) {
    registrarEvento("Meditación finalizada.");
    iniciarChatConversacional(preguntaCierreMeditacion);
    return;
  }

  const paso = pasosMeditacion[indicePasoMeditacion];
  const audioB64 = audiosMeditacion[indicePasoMeditacion] || "";
  textoEl.textContent = paso.texto;
  circulo?.classList.add("respirando");

  const pausaMs = Math.max((paso.pausa_seg || 5) * 1000, 2000);

  if (audioB64 && !audioSilenciado) {
    reproducirAudioAutomatico(audioB64, () => {
      timerMeditacionId = setTimeout(avanzarPasoMeditacion, pausaMs);
    });
  } else {
    timerMeditacionId = setTimeout(avanzarPasoMeditacion, pausaMs);
  }
}

// =================================================================
// CONVERSACIÓN MULTI-TURNO — post ejercicio o post meditación
// =================================================================
const chatHistorial = []; // [{rol: "usuario"|"ia", texto: "..."}]

function iniciarChatConversacional(preguntaInicial) {
  mostrarPantalla("pantalla-chat");
  const chatEl = document.getElementById("chat-mensajes");
  if (chatEl) chatEl.innerHTML = "";
  chatHistorial.length = 0;

  const pregunta = preguntaInicial ||
    (estado.ejercicioActualDetalle && estado.ejercicioActualDetalle.fundamento
      ? "¿Cómo te quedaste después del ejercicio? ¿Qué notás ahora?"
      : "¿Cómo te quedaste con esto? ¿Qué notás ahora?");

  agregarBurbuja("ia", pregunta);
  chatHistorial.push({ rol: "ia", texto: pregunta });

  if (!audioSilenciado) {
    (async () => {
      const form = new FormData();
      form.append("texto", pregunta);
      try {
        const resp = await fetch(`${API_BASE}/tts`, { method: "POST", body: form });
        const data = await resp.json();
        if (data.audio_base64) reproducirAudioAutomatico(data.audio_base64, () => {});
      } catch (e) { /* silencioso */ }
    })();
  }

  guardarSesionEnLocalStorage();
}

function agregarBurbuja(rol, texto) {
  const chatEl = document.getElementById("chat-mensajes");
  if (!chatEl) return;
  const div = document.createElement("div");
  div.className = `burbuja burbuja-${rol}`;
  div.textContent = texto;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

async function enviarMensajeChat() {
  const inputEl = document.getElementById("chat-input-texto");
  const mensaje = inputEl?.value?.trim();
  if (!mensaje) return;
  inputEl.value = "";

  agregarBurbuja("usuario", mensaje);
  chatHistorial.push({ rol: "usuario", texto: mensaje });

  const chatEl = document.getElementById("chat-mensajes");
  const typing = document.createElement("div");
  typing.className = "burbuja burbuja-ia burbuja-typing";
  typing.textContent = "•••";
  chatEl?.appendChild(typing);
  chatEl.scrollTop = chatEl.scrollHeight;

  const form = new FormData();
  form.append("mensaje_usuario", mensaje);
  form.append("dominio", estado.dominioActual);
  form.append("herramienta", estado.herramientaActual);
  form.append("relato_original", estado.relatoTexto);
  form.append("historial_json", JSON.stringify(chatHistorial));

  try {
    const res = await fetch(`${API_BASE}/conversar`, { method: "POST", body: form });
    const data = await res.json();

    typing.remove();
    agregarBurbuja("ia", data.texto);
    chatHistorial.push({ rol: "ia", texto: data.texto });
    guardarSesionEnLocalStorage();

    if (data.audio_base64 && !audioSilenciado) {
      reproducirAudioAutomatico(data.audio_base64, () => {});
    }

    if (data.sugiere_cerrar) {
      const btn = document.getElementById("btn-chat-finalizar");
      if (btn) {
        btn.classList.add("btn-primario");
        btn.classList.remove("btn-secundario");
        btn.textContent = "✓ Cerrar y continuar";
      }
    }
  } catch (e) {
    typing.remove();
    agregarBurbuja("ia", "¿Podés repetir eso? No pude procesar bien tu mensaje.");
  }
}

document.getElementById("btn-enviar-chat")?.addEventListener("click", enviarMensajeChat);

document.getElementById("chat-input-texto")?.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    enviarMensajeChat();
  }
});

// Grabación de voz en el chat (mismo patrón que la grabación de audio del canal)
let grabandoChat = false;
let mediaRecorderChat = null;
let chunksChat = [];

document.getElementById("btn-grabar-chat")?.addEventListener("click", async function () {
  const btnGrabarChat = this;
  if (!grabandoChat) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksChat = [];
      mediaRecorderChat = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderChat.ondataavailable = e => { if (e.data.size > 0) chunksChat.push(e.data); };
      mediaRecorderChat.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksChat, { type: "audio/webm" });
        const file = new File([blob], "chat.webm", { type: "audio/webm" });
        const form = new FormData();
        form.append("audio", file);
        const { texto } = await fetch(`${API_BASE}/transcribir`, {
          method: "POST", body: form,
        }).then(r => r.json()).catch(() => ({ texto: "" }));
        if (texto) {
          const inputEl = document.getElementById("chat-input-texto");
          if (inputEl) inputEl.value = texto;
          enviarMensajeChat();
        }
      };
      mediaRecorderChat.start(200);
      grabandoChat = true;
      btnGrabarChat.textContent = "⏹ Detener";
      btnGrabarChat.classList.add("grabando");
      setTimeout(() => { if (grabandoChat) btnGrabarChat.click(); }, 30000);
    } catch (e) {
      alert("No se pudo acceder al micrófono.");
    }
  } else {
    mediaRecorderChat?.stop();
    grabandoChat = false;
    btnGrabarChat.textContent = "🎙️ Voz";
    btnGrabarChat.classList.remove("grabando");
  }
});

document.getElementById("btn-chat-finalizar")?.addEventListener("click", () => {
  mostrarPantalla("pantalla-ruteo");
});

// =================================================================
// LOCALSTORAGE — recordar sesiones anteriores (solo local, sin backend)
// =================================================================
function guardarSesionEnLocalStorage() {
  try {
    const key = "im_sesion_" + (estado.nombreUsuario || "anonimo");
    const data = {
      fecha: new Date().toISOString(),
      dominio: estado.dominioActual,
      energia: estado.energiaActual || "baja",
      categoriaAnimo: estado.categoriaAnimoActual || null,
      relato: (estado.relatoTexto || "").substring(0, 200),
      historial: chatHistorial.slice(-10),
    };
    const sesiones = JSON.parse(localStorage.getItem(key) || "[]");
    const hoy = new Date().toDateString();
    const idx = sesiones.findIndex(s => new Date(s.fecha).toDateString() === hoy);
    if (idx >= 0) sesiones[idx] = data;
    else sesiones.push(data);
    if (sesiones.length > 20) sesiones.shift();
    localStorage.setItem(key, JSON.stringify(sesiones));
  } catch (e) { /* sin localStorage disponible */ }
}

function cargarSesionAnterior(nombre) {
  try {
    const key = "im_sesion_" + nombre;
    const sesiones = JSON.parse(localStorage.getItem(key) || "[]");
    const hoy = new Date().toDateString();
    return sesiones.filter(s => new Date(s.fecha).toDateString() !== hoy).slice(-1)[0] || null;
  } catch (e) { return null; }
}

// FIX: esto se dispara DESPUÉS de que estado.nombreUsuario ya está seteado
// (justo cuando se confirma login/registro), no al hacer click en "Iniciar sesión"
// —momento en el que ese nombre todavía no existía.
function mostrarSaludoConSesionAnterior() {
  const sesionAnterior = cargarSesionAnterior(estado.nombreUsuario);
  if (!sesionAnterior) return;
  const fecha = new Date(sesionAnterior.fecha).toLocaleDateString("es-AR", {
    weekday: "long", day: "numeric", month: "long"
  });
  const saludo = document.getElementById("saludo-usuario");
  if (saludo) {
    saludo.textContent += ` · Última sesión: ${ETIQUETAS_DOMINIO[sesionAnterior.dominio] || sesionAnterior.dominio || ""} (${fecha})`;
  }
}

// =================================================================
// OJITO — mostrar/ocultar contraseña en el campo compartido de
// registro e inicio de sesión.
// =================================================================
document.getElementById("btn-ojito-password")?.addEventListener("click", (e) => {
  const input = document.getElementById("input-password");
  if (!input) return;
  const oculto = input.type === "password";
  input.type = oculto ? "text" : "password";
  e.currentTarget.textContent = oculto ? "🙈" : "👁️";
});

// =================================================================
// REPORTES — guardar y listar los PDF generados en este dispositivo
// =================================================================
function guardarReporteEnLocalStorage() {
  try {
    const key = "im_reportes_" + (estado.nombreUsuario || "anonimo");
    const reportes = JSON.parse(localStorage.getItem(key) || "[]");
    reportes.push({
      fecha: new Date().toISOString(),
      nombreUsuario: estado.nombreUsuario,
      eventosSesion: estado.eventosSesion,
    });
    if (reportes.length > 30) reportes.shift();
    localStorage.setItem(key, JSON.stringify(reportes));
  } catch (e) { /* sin localStorage disponible */ }
}

function renderizarReportes() {
  const cont = document.getElementById("lista-reportes");
  const vacio = document.getElementById("reportes-vacio");
  if (!cont) return;
  cont.innerHTML = "";

  let reportes = [];
  try {
    const key = "im_reportes_" + (estado.nombreUsuario || "anonimo");
    reportes = JSON.parse(localStorage.getItem(key) || "[]");
  } catch (e) { /* nada guardado */ }

  vacio?.classList.toggle("oculto", reportes.length > 0);
  if (reportes.length === 0) return;

  reportes.slice().reverse().forEach((rep) => {
    const fecha = new Date(rep.fecha).toLocaleDateString("es-AR", {
      day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    const fila = document.createElement("div");
    fila.className = "reporte-item";
    fila.innerHTML = `
      <span class="reporte-fecha">${fecha}</span>
      <button class="btn-reporte-descargar">⬇ Descargar</button>
    `;
    fila.querySelector("button").addEventListener("click", async (e) => {
      const boton = e.currentTarget;
      boton.textContent = "Generando...";
      boton.disabled = true;
      try {
        const form = new FormData();
        form.append("nombre_usuario", rep.nombreUsuario || estado.nombreUsuario);
        form.append("eventos_json", JSON.stringify(rep.eventosSesion || []));
        const resp = await fetch(`${API_BASE}/reporte`, { method: "POST", body: form });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `Integramente_Reporte_${fecha.replace(/[/, :]/g, "-")}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (err) {
        boton.textContent = "Error, probá de nuevo";
      } finally {
        boton.textContent = "⬇ Descargar";
        boton.disabled = false;
      }
    });
    cont.appendChild(fila);
  });
}

// =================================================================
// MÉTRICAS — dominios más trabajados + energía por fecha
// =================================================================
function renderizarMetricas() {
  const contDominios = document.getElementById("metricas-grafico-dominios");
  const contEnergia  = document.getElementById("metricas-grafico-energia");
  const vacio        = document.getElementById("metricas-vacio");
  if (!contDominios || !contEnergia) return;
  contDominios.innerHTML = "";
  contEnergia.innerHTML  = "";

  let sesiones = [];
  try {
    const key = "im_sesion_" + (estado.nombreUsuario || "anonimo");
    sesiones = JSON.parse(localStorage.getItem(key) || "[]");
  } catch (e) { /* nada guardado */ }

  vacio?.classList.toggle("oculto", sesiones.length > 0);
  if (sesiones.length === 0) return;

  // --- Gráfico de barras: veces por dominio ---
  const conteo = { Cuerpo: 0, Lenguaje: 0, Emocion: 0 };
  sesiones.forEach(s => { if (conteo[s.dominio] !== undefined) conteo[s.dominio]++; });
  const maxConteo = Math.max(...Object.values(conteo), 1);

  Object.entries(conteo).forEach(([dominio, cant]) => {
    const pct = Math.round((cant / maxConteo) * 100);
    const fila = document.createElement("div");
    fila.className = "metrica-barra-fila";
    fila.innerHTML = `
      <span class="metrica-barra-label">${ETIQUETAS_DOMINIO[dominio] || dominio}</span>
      <div class="metrica-barra-track"><div class="metrica-barra-fill" style="width:${pct}%"></div></div>
      <span class="metrica-barra-valor">${cant}</span>
    `;
    contDominios.appendChild(fila);
  });

  // --- Línea de tiempo: energía por fecha ---
  sesiones.slice().reverse().forEach(s => {
    const fecha = new Date(s.fecha).toLocaleDateString("es-AR", { day: "numeric", month: "short" });
    const esAlta = s.energia === "alta";
    const fila = document.createElement("div");
    fila.className = "metrica-energia-fila";
    fila.innerHTML = `
      <span class="metrica-energia-fecha">${fecha}</span>
      <span class="metrica-energia-punto ${esAlta ? "alta" : "baja"}"></span>
      <span class="metrica-energia-label">${esAlta ? "Energía alta" : "Energía baja / pausa"}</span>
    `;
    contEnergia.appendChild(fila);
  });
}

