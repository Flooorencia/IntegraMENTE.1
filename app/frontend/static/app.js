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
  // NUEVO: autoinforme de ánimo al cierre, para poder comparar contra
  // categoriaAnimoActual (que se fija en el diagnóstico inicial) y así
  // responder si hay mejora autoinformada entre inicio y cierre de sesión.
  categoriaAnimoFinal: null,
};

const ETIQUETAS_DOMINIO    = { Cuerpo: "Cuerpo", Lenguaje: "Lenguaje", Emocion: "Emoción" };
const ETIQUETAS_HERRAMIENTA = {
  practica_guiada: "Ejercicio del momento",
  microaudio: "Meditación guiada",
  bitacora: "Tu bitácora",
};

function registrarEvento(texto) {
  estado.eventosSesion.push(texto);
}

// -----------------------------------------------------------------
// NAVEGACIÓN — con historial para el botón atrás global
// -----------------------------------------------------------------
const PANTALLAS_SIN_ATRAS = new Set(["pantalla-bienvenida", "pantalla-sesion-finalizada"]);
// FIX: el botón atrás (header) durante una sesión activa (chat,
// ejercicio o meditación) llevaba directo a la pantalla de dominios sin
// ningún aviso — daba la sensación de que "salir" no hacía nada, cuando
// en realidad solo estaba navegando hacia atrás en el historial. Ahora,
// en estas pantallas puntuales, el botón atrás pasa por la misma
// confirmación de "Finalizar sesión" que ya existe en el menú, en vez
// de saltar directo a otra pantalla sin preguntar.
const PANTALLAS_CONFIRMAR_ANTES_DE_ATRAS = new Set(["pantalla-chat", "pantalla-ejercicio", "pantalla-meditacion"]);
const PANTALLAS_SIN_MENU  = new Set(["pantalla-bienvenida", "pantalla-registro", "pantalla-usuario-creado", "pantalla-sesion-finalizada"]);
const historialPantallas = [];
let pantallaActualId = "pantalla-bienvenida";

function mostrarPantalla(id, opts = {}) {
  // FIX GENERAL: cualquier audio en curso se corta al cambiar de pantalla,
  // sin importar desde dónde se disparó (consigna, chat, meditación, etc.)
  if (reproductor && !reproductor.paused) reproductor.pause();
  if (id !== "pantalla-meditacion" && id !== "pantalla-ejercicio") detenerMusicaFondo();
  // FIX: el temporizador de pasos de meditación se cancela siempre al
  // navegar, así nunca puede disparar un paso "fantasma" en otra pantalla
  // (era la causa de los saltos inesperados de pantalla).
  clearTimeout(timerMeditacionId);
  clearTimeout(timerEjercicioId);
  if (id !== "pantalla-chat") { clearTimeout(temporizadorAvisoChatId); ocultarAvisoTiempoChat(); }
  // FIX GRABACIÓN PEGADA: al salir del chat hacia cualquier otra pantalla,
  // se corta cualquier grabación en curso y se descarta el texto transcripto
  // que haya quedado sin enviar en el cuadro — así no reaparece "pegado"
  // si la persona vuelve más tarde a otra herramienta.
  if (pantallaActualId === "pantalla-chat" && id !== "pantalla-chat") {
    limpiarGrabacionChatPendiente();
  }
  // Si se sale de la meditación por cualquier vía que no sea seguir
  // avanzando en ella misma (menú, botón atrás, etc.), se borra el
  // progreso guardado — ya no haría falta retomarla.
  if (pantallaActualId === "pantalla-meditacion" && id !== "pantalla-meditacion") {
    borrarProgresoMeditacion();
  }
  if (botonAudioActivo) {
    botonAudioActivo.textContent = textoOriginalBotonAudio;
    botonAudioActivo = null;
  }

  document.querySelectorAll(".pantalla").forEach(p => p.classList.remove("activa"));
  const seccionNueva = document.getElementById(id);
  seccionNueva.classList.add("activa");
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

  const saludoEl = document.getElementById("saludo-usuario");
  if (saludoEl) saludoEl.classList.toggle("oculto", id !== "pantalla-canal" || !saludoEl.textContent);
}

document.getElementById("btn-atras-global")?.addEventListener("click", () => {
  if (PANTALLAS_CONFIRMAR_ANTES_DE_ATRAS.has(pantallaActualId)) {
    mostrarPantalla("pantalla-confirmar-cierre");
    return;
  }
  const anterior = historialPantallas.pop();
  if (anterior) mostrarPantalla(anterior, { esVolver: true });
});

// -----------------------------------------------------------------
// MENÚ GLOBAL — silenciador, métricas, reportes, finalizar sesión
// -----------------------------------------------------------------
let audioSilenciado = false;
let chatEnCurso = false;

document.getElementById("btn-menu-global")?.addEventListener("click", (e) => {
  e.stopPropagation();
  document.getElementById("menu-item-volver-chat")?.classList.toggle("oculto", !chatEnCurso || pantallaActualId === "pantalla-chat");
  document.getElementById("menu-global-panel")?.classList.toggle("oculto");
});
document.addEventListener("click", () => {
  document.getElementById("menu-global-panel")?.classList.add("oculto");
});

document.getElementById("menu-item-volver-chat")?.addEventListener("click", () => {
  document.getElementById("menu-global-panel")?.classList.add("oculto");
  mostrarPantalla("pantalla-chat");
});

document.getElementById("menu-item-silenciar")?.addEventListener("click", (e) => {
  audioSilenciado = !audioSilenciado;
  e.currentTarget.textContent = audioSilenciado ? "🔇 Activar audio" : "🔊 Silenciar";
  if (audioSilenciado) {
    if (reproductor && !reproductor.paused) reproductor.pause();
    pausarMusicaFondo();
  } else {
    if (reproductor && reproductor.src) reproductor.play().catch(() => {});
    reanudarMusicaFondo();
  }
  document.getElementById("menu-global-panel")?.classList.add("oculto");
});

document.getElementById("menu-item-nosotros")?.addEventListener("click", () => {
  document.getElementById("menu-global-panel")?.classList.add("oculto");
  cargarAcercaDe();
  mostrarPantalla("pantalla-nosotros");
});

async function cargarAcercaDe() {
  const tituloEl    = document.getElementById("acerca-de-titulo");
  const parrafosEl  = document.getElementById("acerca-de-parrafos");
  const creditosEl  = document.getElementById("acerca-de-creditos");
  try {
    const resp = await fetch("/static/contenido/acerca-de.json", { cache: "no-store" });
    if (!resp.ok) throw new Error("no se pudo leer el archivo");
    const data = await resp.json();
    if (tituloEl) tituloEl.textContent = data.titulo || "Acerca de ÍntegraMENTE";
    if (parrafosEl) {
      parrafosEl.innerHTML = "";
      (data.parrafos || []).forEach(texto => {
        const p = document.createElement("p");
        p.textContent = texto;
        parrafosEl.appendChild(p);
      });
    }
    if (creditosEl) creditosEl.textContent = data.creditos || "";
  } catch (e) {
    if (parrafosEl) parrafosEl.innerHTML = "<p>No pudimos cargar este contenido en este momento.</p>";
  }
}

document.getElementById("menu-item-preguntas")?.addEventListener("click", () => {
  document.getElementById("menu-global-panel")?.classList.add("oculto");
  cargarPreguntasFrecuentes();
  mostrarPantalla("pantalla-preguntas");
});

async function cargarPreguntasFrecuentes() {
  const tituloEl = document.getElementById("preguntas-titulo");
  const listaEl  = document.getElementById("preguntas-lista");
  if (!listaEl) return;
  try {
    const resp = await fetch("/static/contenido/preguntas-frecuentes.json", { cache: "no-store" });
    if (!resp.ok) throw new Error("no se pudo leer el archivo");
    const data = await resp.json();
    if (tituloEl) tituloEl.textContent = data.titulo || "Preguntas frecuentes";
    listaEl.innerHTML = "";
    (data.items || []).forEach((item, i) => {
      const div = document.createElement("div");
      div.className = "faq-item";
      div.innerHTML = `
        <button type="button" class="faq-pregunta" id="faq-pregunta-${i}">
          <span>${item.pregunta}</span>
          <span class="faq-flecha">▾</span>
        </button>
        <div class="faq-respuesta"><p>${item.respuesta}</p></div>
      `;
      div.querySelector(".faq-pregunta").addEventListener("click", () => {
        div.classList.toggle("abierto");
      });
      listaEl.appendChild(div);
    });
  } catch (e) {
    listaEl.innerHTML = "<p>No pudimos cargar este contenido en este momento.</p>";
  }
}

// -----------------------------------------------------------------
// TU OPINIÓN — comentario + puntuación de 1 a 5 estrellas.
// Se guarda solo en este dispositivo (mismo criterio que frases,
// métricas y reportes), consistente con la confidencialidad prometida.
// -----------------------------------------------------------------
let opinionPuntuacion = 0;
const LEYENDAS_ESTRELLAS = {
  1: "1 — no la recomiendo",
  2: "2",
  3: "3",
  4: "4",
  5: "5 — la súper recomiendo",
};

document.getElementById("menu-item-opinion")?.addEventListener("click", () => {
  document.getElementById("menu-global-panel")?.classList.add("oculto");
  reiniciarPantallaOpinion();
  mostrarPantalla("pantalla-opinion");
});

function reiniciarPantallaOpinion() {
  opinionPuntuacion = 0;
  document.querySelectorAll(".opinion-estrella").forEach(b => b.classList.remove("activa"));
  const leyendaEl = document.getElementById("opinion-estrellas-leyenda");
  if (leyendaEl) leyendaEl.textContent = "Tocá una estrella para puntuar";
  const textoEl = document.getElementById("opinion-texto");
  if (textoEl) { textoEl.value = ""; textoEl.classList.remove("oculto"); }
  document.getElementById("opinion-estrellas")?.classList.remove("oculto");
  document.getElementById("btn-opinion-enviar")?.classList.remove("oculto");
  document.getElementById("opinion-gracias")?.classList.add("oculto");
}

document.querySelectorAll(".opinion-estrella").forEach(btn => {
  btn.addEventListener("click", () => {
    opinionPuntuacion = Number(btn.dataset.valor);
    document.querySelectorAll(".opinion-estrella").forEach(b => {
      b.classList.toggle("activa", Number(b.dataset.valor) <= opinionPuntuacion);
    });
    const leyendaEl = document.getElementById("opinion-estrellas-leyenda");
    if (leyendaEl) leyendaEl.textContent = LEYENDAS_ESTRELLAS[opinionPuntuacion] || "";
  });
});

document.getElementById("btn-opinion-enviar")?.addEventListener("click", () => {
  const textoEl = document.getElementById("opinion-texto");
  const comentario = textoEl?.value?.trim() || "";
  if (!opinionPuntuacion && !comentario) {
    alert("Elegí una puntuación o escribí un comentario antes de enviar.");
    return;
  }
  try {
    const key = "im_opiniones_" + (estado.nombreUsuario || "anonimo");
    const opiniones = JSON.parse(localStorage.getItem(key) || "[]");
    opiniones.push({
      fecha: new Date().toISOString(),
      puntuacion: opinionPuntuacion,
      comentario,
      // NUEVO: se guarda a qué dominio/herramienta corresponde esta
      // opinión, para poder cruzar utilidad percibida vs. dominio o
      // herramienta usada.
      dominio: estado.dominioActual || null,
      herramienta: estado.herramientaActual || null,
    });
    localStorage.setItem(key, JSON.stringify(opiniones));
  } catch (e) { /* sin localStorage disponible */ }

  registrarEvento(`Opinión guardada: ${opinionPuntuacion || "sin puntuación"} estrellas.`);
  document.getElementById("opinion-estrellas")?.classList.add("oculto");
  textoEl?.classList.add("oculto");
  document.getElementById("btn-opinion-enviar")?.classList.add("oculto");
  document.getElementById("opinion-gracias")?.classList.remove("oculto");
});

document.getElementById("menu-item-frases")?.addEventListener("click", () => {
  document.getElementById("menu-global-panel")?.classList.add("oculto");
  renderizarFrases();
  mostrarPantalla("pantalla-frases");
});

// -----------------------------------------------------------------
// PANEL ADMINISTRADOR — candado liviano (clave en ADMIN_CLAVE de Render)
// más lectura de las opiniones guardadas en localStorage + promedio.
// -----------------------------------------------------------------
document.getElementById("menu-item-admin")?.addEventListener("click", () => {
  document.getElementById("menu-global-panel")?.classList.add("oculto");
  const inputClave = document.getElementById("input-admin-clave");
  if (inputClave) inputClave.value = "";
  document.getElementById("admin-error")?.classList.add("oculto");
  mostrarPantalla("pantalla-admin-candado");
});

document.getElementById("btn-admin-entrar")?.addEventListener("click", async () => {
  const clave = document.getElementById("input-admin-clave")?.value || "";
  const errorEl = document.getElementById("admin-error");
  errorEl?.classList.add("oculto");

  try {
    const form = new FormData();
    form.append("clave", clave);
    const resp = await fetch(`${API_BASE}/admin/verificar`, { method: "POST", body: form });
    const data = await resp.json();
    if (data.ok) {
      renderizarEstadisticasAdmin();
      mostrarPantalla("pantalla-admin-estadisticas");
    } else {
      errorEl?.classList.remove("oculto");
    }
  } catch (e) {
    errorEl?.classList.remove("oculto");
  }
});

// Enter en el campo de clave = mismo efecto que tocar "Entrar"
document.getElementById("input-admin-clave")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-admin-entrar")?.click();
});

function renderizarEstadisticasAdmin() {
  const listaEl = document.getElementById("admin-lista-opiniones");
  const promedioEl = document.getElementById("admin-promedio");
  const vacioEl = document.getElementById("admin-opiniones-vacio");
  if (!listaEl) return;
  listaEl.innerHTML = "";

  let opiniones = [];
  try {
    const key = "im_opiniones_" + (estado.nombreUsuario || "anonimo");
    opiniones = JSON.parse(localStorage.getItem(key) || "[]");
  } catch (e) { /* sin localStorage disponible */ }

  vacioEl?.classList.toggle("oculto", opiniones.length > 0);

  if (opiniones.length === 0) {
    if (promedioEl) promedioEl.textContent = "Todavía no hay opiniones.";
    return;
  }

  const conPuntuacion = opiniones.filter(o => o.puntuacion > 0);
  const promedio = conPuntuacion.length
    ? (conPuntuacion.reduce((acc, o) => acc + o.puntuacion, 0) / conPuntuacion.length).toFixed(1)
    : "—";
  if (promedioEl) {
    promedioEl.textContent = `Promedio: ${promedio} ★ — ${opiniones.length} opinión(es) — solo en este dispositivo`;
  }

  [...opiniones].reverse().forEach(o => {
    const div = document.createElement("div");
    div.className = "admin-opinion-item";
    const estrellas = "★".repeat(o.puntuacion || 0) + "☆".repeat(5 - (o.puntuacion || 0));
    const fecha = o.fecha ? new Date(o.fecha).toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric" }) : "";
    div.innerHTML = `
      <div class="admin-opinion-estrellas">${estrellas}</div>
      <div class="admin-opinion-fecha">${fecha}</div>
      <p>${o.comentario ? o.comentario : "<em>Sin comentario escrito.</em>"}</p>
    `;
    listaEl.appendChild(div);
  });
}

function guardarFrasePoderosaEnLocalStorage(frase, explicacion) {
  if (!frase) return;
  try {
    const key = "im_frases_" + (estado.nombreUsuario || "anonimo");
    const frases = JSON.parse(localStorage.getItem(key) || "[]");
    frases.push({
      fecha: new Date().toISOString(),
      dominio: estado.dominioActual,
      frase, explicacion: explicacion || "",
    });
    localStorage.setItem(key, JSON.stringify(frases));
  } catch (e) { /* sin localStorage disponible */ }
}

const ICONOS_DOMINIO = { Cuerpo: "🧘", Lenguaje: "✍️", Emocion: "💗" };

function renderizarFrases() {
  const cont = document.getElementById("lista-frases");
  const vacio = document.getElementById("frases-vacio");
  if (!cont) return;
  cont.innerHTML = "";

  let frases = [];
  try {
    const key = "im_frases_" + (estado.nombreUsuario || "anonimo");
    frases = JSON.parse(localStorage.getItem(key) || "[]");
  } catch (e) { /* nada guardado */ }

  vacio?.classList.toggle("oculto", frases.length > 0);
  if (frases.length === 0) return;

  const porDominio = { Cuerpo: [], Lenguaje: [], Emocion: [] };
  frases.forEach(f => { if (porDominio[f.dominio]) porDominio[f.dominio].push(f); });

  Object.entries(porDominio).forEach(([dominio, lista]) => {
    if (lista.length === 0) return;
    const titulo = document.createElement("h3");
    titulo.className = "metricas-subtitulo";
    titulo.textContent = `${ICONOS_DOMINIO[dominio] || ""} ${ETIQUETAS_DOMINIO[dominio] || dominio}`;
    cont.appendChild(titulo);

    lista.slice().reverse().forEach(f => {
      const fecha = new Date(f.fecha).toLocaleDateString("es-AR", { day: "numeric", month: "short" });
      const item = document.createElement("button");
      item.type = "button";
      item.className = "frase-item";
      item.innerHTML = `<span class="frase-item-texto">"${f.frase}"</span><span class="frase-item-fecha">${fecha}</span>`;
      item.addEventListener("click", () => mostrarTarjetaFrase(f));
      cont.appendChild(item);
    });
  });
}

function mostrarTarjetaFrase(f) {
  const fecha = new Date(f.fecha).toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" });

  // FIX: al abrir una frase guardada desde el menú, antes se dejaban sin
  // tocar los elementos de "lo que veo en lo que escribiste" (mostraban
  // el placeholder "…" del HTML) y la tarjeta de la frase en sí quedaba
  // oculta — porque esta pantalla se comparte con la de generación en
  // vivo, que sí tiene esos tres campos. De lo guardado solo existen
  // frase + explicación (no se guarda el "darse cuenta" completo), así
  // que acá se oculta esa primera tarjeta por completo y se muestra solo
  // la de la frase, ya con sus datos reales.
  document.getElementById("tarjeta-insight-bitacora")?.classList.add("oculto");
  const tarjeta = document.getElementById("tarjeta-frase-poderosa");
  tarjeta?.classList.remove("oculto");

  document.getElementById("texto-frase-poderosa").textContent = f.frase;
  document.getElementById("texto-frase-explicacion").textContent = f.explicacion || "";

  // FIX punto 4/7: el botón de escuchar ahora sí pide el audio por TTS
  // en el momento (antes quedaba con onclick = null, sin hacer nada).
  const btnEscuchar = document.getElementById("btn-reproducir-frase-poderosa");
  if (btnEscuchar) {
    const textoOriginal = btnEscuchar.textContent;
    btnEscuchar.onclick = async () => {
      btnEscuchar.disabled = true;
      btnEscuchar.textContent = "Cargando...";
      try {
        const form = new FormData();
        form.append("texto", f.frase);
        const resp = await fetch(`${API_BASE}/tts`, { method: "POST", body: form });
        const data = await resp.json();
        if (data.audio_base64) reproducirAudioAutomatico(data.audio_base64, () => {});
      } catch (e) {
        // Sin audio disponible — la persona igual puede leer la frase.
      } finally {
        btnEscuchar.disabled = false;
        btnEscuchar.textContent = textoOriginal;
      }
    };
  }

  const eyebrow = tarjeta?.querySelector(".eyebrow");
  if (eyebrow) eyebrow.textContent = `${ETIQUETAS_DOMINIO[f.dominio] || f.dominio} — ${fecha}`;
  document.getElementById("btn-continuar-bitacora")?.classList.add("oculto");
  mostrarPantalla("pantalla-bitacora-insight");
}

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
  mostrarPantalla("pantalla-confirmar-cierre");
});

document.getElementById("btn-confirmar-cierre-si")?.addEventListener("click", () => {
  registrarEvento("Sesión finalizada desde el menú.");
  mostrarPantalla("pantalla-sesion-finalizada");
});

document.getElementById("btn-confirmar-cierre-no")?.addEventListener("click", () => {
  const anterior = historialPantallas.pop();
  if (anterior) mostrarPantalla(anterior, { esVolver: true });
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
  document.getElementById("saludo-usuario").innerHTML = `<span>Hola, ${nombre}</span>`;
  registrarEvento(`Sesión iniciada por ${nombre}.`);
  iniciarSesionApp();
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
    // Invisible de verdad: se usan los datos para el diagnóstico, pero
    // NUNCA se dibuja nada sobre el video (ni puntos, ni malla, ni etiqueta).
    actualizarPanelFacial(vals);
    limpiarCanvas();
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
    if (data.audio_base64 && !audioSilenciado) {
      reproducirAudioBase64(data.audio_base64, document.getElementById("btn-reproducir-diagnostico"));
    }

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
    // FIX MÚSICA: desbloquea el audio ACÁ, en el mismo click del usuario
    // (no después de un await) — los navegadores móviles solo permiten
    // reproducir audio automáticamente si el primer play() ocurre pegado
    // a un gesto directo. Sin esto, iniciarMusicaFondo() se llamaba recién
    // después de esperar la respuesta del servidor y el navegador lo
    // bloqueaba en silencio la mayoría de las veces.
    desbloquearAudio();
    estado.herramientaActual = tarjeta.dataset.herramienta;
    registrarEvento(`Herramienta elegida: ${ETIQUETAS_HERRAMIENTA[estado.herramientaActual]}.`);
    if (estado.herramientaActual === "microaudio") {
      pedirMeditacion();
    } else if (estado.herramientaActual === "bitacora") {
      iniciarBitacora();
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
// -----------------------------------------------------------------
// EJERCICIO DEL MOMENTO — GUIADO POR PASOS (misma estructura que la
// meditación: círculo, puntos, voz premium lazy, música de fondo).
// -----------------------------------------------------------------
let pasosEjercicio = [];
let cacheAudioEjercicio = {};
let indicePasoEjercicio = 0;
let timerEjercicioId = null;
let fundamentoEjercicioActual = "";
let preguntaCierreEjercicioActual = "";

document.getElementById("btn-saltear-ejercicio")?.addEventListener("click", () => {
  clearTimeout(timerEjercicioId);
  detenerMusicaFondo();
  registrarEvento("Ejercicio del momento salteado antes de terminar.");
  finalizarEjercicioYPasarAlChat();
});

async function pedirEjercicio() {
  mostrarPantalla("pantalla-analisis");
  const variante = estado.historialEjercicios[estado.dominioActual][estado.herramientaActual];

  const form = new FormData();
  form.append("dominio", estado.dominioActual);
  form.append("relato_texto", estado.relatoTexto);
  form.append("variante_idx", variante);

  let data;
  try {
    const resp = await fetch(`${API_BASE}/ejercicio-guiado`, { method: "POST", body: form });
    data = await resp.json();
  } catch (e) {
    data = {
      intro: "Te invito a hacer una breve pausa activa.",
      pasos: [{ texto: "Respirá hondo y soltá el aire despacio.", pausa_seg: 5 }],
      fundamento: "Anclar la atención en el cuerpo interrumpe el círculo de pensamientos repetitivos.",
      pregunta_cierre: "¿Qué notaste distinto al hacerlo?",
      audio_intro_base64: "",
    };
  }

  estado.historialEjercicios[estado.dominioActual][estado.herramientaActual]++;
  registrarEvento(`Ejercicio del momento iniciado: ${data.intro || ""}`);

  pasosEjercicio = data.pasos || [];
  cacheAudioEjercicio = {};
  fundamentoEjercicioActual = data.fundamento || "";
  preguntaCierreEjercicioActual = data.pregunta_cierre || "¿Cómo te quedaste con esto?";
  indicePasoEjercicio = -1;

  document.getElementById("eyebrow-ejercicio").textContent =
    `Ejercicio en curso: ${ETIQUETAS_DOMINIO[estado.dominioActual]} — Ejercicio del momento`;

  pintarPuntosEjercicio();
  mostrarPantalla("pantalla-ejercicio");
  iniciarMusicaFondo();

  if (pasosEjercicio[0]) {
    fetchAudioPaso(pasosEjercicio[0].texto).then(b64 => { cacheAudioEjercicio[0] = b64; });
  }

  const textoEl = document.getElementById("ejercicio-texto-paso");
  textoEl.textContent = data.intro || "Empecemos.";
  if (data.audio_intro_base64 && !audioSilenciado) {
    reproducirAudioAutomatico(data.audio_intro_base64, () => avanzarPasoEjercicio());
  } else {
    timerEjercicioId = setTimeout(avanzarPasoEjercicio, 2000);
  }
}

function pintarPuntosEjercicio() {
  const cont = document.getElementById("ejercicio-puntos");
  if (!cont) return;
  cont.innerHTML = "";
  pasosEjercicio.forEach((_, i) => {
    const p = document.createElement("span");
    p.className = "meditacion-punto" + (i === indicePasoEjercicio ? " activo" : "");
    cont.appendChild(p);
  });
}

// -----------------------------------------------------------------
// FIX: cierre real del Ejercicio del momento — antes pasaba de golpe
// del último paso al chat, sin ningún aviso de que el ejercicio había
// terminado, y sin voz en el fundamento/pregunta de después (esos
// campos de audio nunca se pedían al backend). Ahora se muestra un
// "Listo, terminaste el ejercicio" en el mismo círculo, se pide el
// audio del fundamento y la pregunta al endpoint dedicado, y recién
// después se pasa al chat — con una pausa real entre el fundamento y
// la pregunta para que se sienta como una charla, no todo pegado.
// -----------------------------------------------------------------
async function finalizarEjercicioYPasarAlChat() {
  const circulo = document.getElementById("ejercicio-circulo");
  const textoEl = document.getElementById("ejercicio-texto-paso");
  const puntosEl = document.getElementById("ejercicio-puntos");
  circulo?.classList.remove("respirando");
  const textoCierre = "Cuando estés listo/a, continuá.";
  if (textoEl) textoEl.textContent = textoCierre;
  puntosEl?.classList.add("oculto");
  document.getElementById("btn-saltear-ejercicio")?.classList.add("oculto");

  // FIX: antes este cierre era solo texto en pantalla — si la persona
  // tenía los ojos cerrados (como en la meditación) no se enteraba de
  // que había terminado. Ahora también se dice en voz alta.
  let audioCierrePromise = Promise.resolve();
  if (!audioSilenciado) {
    audioCierrePromise = new Promise((resolve) => {
      (async () => {
        try {
          const form = new FormData();
          form.append("texto", textoCierre);
          const resp = await fetch(`${API_BASE}/tts`, { method: "POST", body: form });
          const data = await resp.json();
          if (data.audio_base64) {
            reproducirAudioAutomatico(data.audio_base64, resolve);
          } else {
            resolve();
          }
        } catch (e) {
          resolve();
        }
      })();
    });
  }

  let audioFundamento = "";
  let audioPregunta = "";
  try {
    const form = new FormData();
    form.append("fundamento", fundamentoEjercicioActual || "");
    form.append("pregunta_cierre", preguntaCierreEjercicioActual || "");
    const resp = await fetch(`${API_BASE}/ejercicio-guiado/audio-cierre`, { method: "POST", body: form });
    if (!resp.ok) throw new Error(`audio-cierre respondió ${resp.status}`);
    const data = await resp.json();
    audioFundamento = data.audio_fundamento_base64 || "";
    audioPregunta = data.audio_pregunta_seguimiento_base64 || "";
  } catch (e) {
    // FIX: antes acá se quedaba en silencio directamente. Ahora, si falla
    // la voz premium (ElevenLabs, ej. por cuota agotada o error de red),
    // se cae a la voz normal del endpoint /tts — así nunca queda mudo,
    // igual que el resto de la app. Se deja el log para poder ver en
    // Render qué estaba fallando si vuelve a pasar.
    console.warn("audio-cierre falló, usando voz de resguardo:", e);
    try {
      const [respF, respP] = await Promise.all([
        fetch(`${API_BASE}/tts`, { method: "POST", body: (() => { const f = new FormData(); f.append("texto", fundamentoEjercicioActual || ""); return f; })() }),
        fetch(`${API_BASE}/tts`, { method: "POST", body: (() => { const f = new FormData(); f.append("texto", preguntaCierreEjercicioActual || ""); return f; })() }),
      ]);
      const dataF = await respF.json();
      const dataP = await respP.json();
      audioFundamento = dataF.audio_base64 || "";
      audioPregunta = dataP.audio_base64 || "";
    } catch (e2) {
      console.warn("Voz de resguardo también falló:", e2);
    }
  }

  estado.ejercicioActualDetalle = {
    fundamento: fundamentoEjercicioActual,
    pregunta_seguimiento: preguntaCierreEjercicioActual,
    audio_fundamento_base64: audioFundamento,
    audio_pregunta_seguimiento_base64: audioPregunta,
  };

  // Espera a que termine de decir "listo, terminamos con esto" (o un
  // máximo de 2.5s si está silenciado / no hay audio) antes de pasar al
  // chat — así el cierre se escucha completo, no se corta a la mitad.
  await Promise.race([audioCierrePromise, new Promise(r => setTimeout(r, 2500))]);
  iniciarChatDesdeEjercicio("");
}

async function avanzarPasoEjercicio() {
  clearTimeout(timerEjercicioId);
  indicePasoEjercicio++;
  pintarPuntosEjercicio();

  const circulo = document.getElementById("ejercicio-circulo");
  const textoEl = document.getElementById("ejercicio-texto-paso");

  if (indicePasoEjercicio >= pasosEjercicio.length) {
    registrarEvento("Ejercicio del momento finalizado.");
    detenerMusicaFondo();
    finalizarEjercicioYPasarAlChat();
    return;
  }

  const paso = pasosEjercicio[indicePasoEjercicio];
  textoEl.textContent = paso.texto;
  circulo?.classList.add("respirando");

  const siguiente = pasosEjercicio[indicePasoEjercicio + 1];
  if (siguiente && cacheAudioEjercicio[indicePasoEjercicio + 1] === undefined) {
    fetchAudioPaso(siguiente.texto).then(b64 => { cacheAudioEjercicio[indicePasoEjercicio + 1] = b64; });
  }

  let audioB64 = cacheAudioEjercicio[indicePasoEjercicio];
  if (audioB64 === undefined) {
    audioB64 = await fetchAudioPaso(paso.texto);
    cacheAudioEjercicio[indicePasoEjercicio] = audioB64;
  }

  const pausaMs = Math.max((paso.pausa_seg || 4) * 1000, 2000);

  if (audioB64 && !audioSilenciado) {
    reproducirAudioAutomatico(audioB64, () => {
      timerEjercicioId = setTimeout(avanzarPasoEjercicio, pausaMs);
    });
  } else {
    timerEjercicioId = setTimeout(avanzarPasoEjercicio, pausaMs);
  }
}

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
document.getElementById("btn-ruteo-finalizar").addEventListener("click", () => {
  mostrarPantalla("pantalla-animo-cierre");
});

// -----------------------------------------------------------------
// NUEVO: autoinforme de ánimo al cierre (mismas 5 categorías que usa
// el diagnóstico inicial, para poder comparar "antes vs. después" de
// forma consistente). Al elegir una, recién ahí se genera el reporte
// y se cierra la sesión — igual que antes, solo que con un paso más.
// -----------------------------------------------------------------
document.querySelectorAll(".btn-animo-cierre").forEach(btn => {
  btn.addEventListener("click", () => {
    estado.categoriaAnimoFinal = btn.dataset.animo;
    guardarSesionEnLocalStorage();
    registrarEvento(`Autoinforme de cierre: ${btn.dataset.animo}.`);
    mostrarPantalla("pantalla-reporte");
    generarReporteAutomatico();
  });
});

// =================================================================
// PANTALLA 11: REPORTE Y DESPEDIDA
// El PDF se genera y se guarda solo (queda disponible en el menú →
// Reportes); no hace falta que la persona toque nada para eso.
// =================================================================
async function generarReporteAutomatico() {
  const estadoTexto = document.getElementById("texto-estado-reporte");
  try {
    guardarReporteEnLocalStorage();
    marcarSesionAppCompletada();
    if (estadoTexto) estadoTexto.textContent = "Tu sesión quedó guardada. Descargala cuando quieras desde el menú, en \"Reportes\".";
  } catch (e) {
    console.warn("Error guardando reporte:", e);
    if (estadoTexto) estadoTexto.textContent = "No pudimos guardar el reporte esta vez, pero tu sesión igual quedó registrada.";
  }
}

document.getElementById("btn-continuar-a-despedida").addEventListener("click", () =>
  mostrarPantalla("pantalla-despedida"));

document.getElementById("btn-sesion-finalizada-volver")?.addEventListener("click", () => {
  chatEnCurso = false;
  estado.nombreUsuario = "";
  historialPantallas.length = 0;
  mostrarPantalla("pantalla-bienvenida");
});

document.getElementById("btn-nueva-sesion").addEventListener("click", () => {
  chatEnCurso = false;
  estado.nombreUsuario   = "";
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
  historialPantallas.length = 0;
  mostrarPantalla("pantalla-bienvenida");
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
];
const musicaFondoEl = document.getElementById("musica-fondo");

// FIX MÚSICA: desbloquea los elementos <audio> con un play()/pause() en
// silencio pegado al gesto real del usuario. Después de esto, llamar a
// .play() más adelante (aunque sea dentro de un async/await) ya no lo
// bloquea el navegador, porque el "permiso" quedó otorgado en esta sesión.
let audioDesbloqueado = false;
function desbloquearAudio() {
  if (audioDesbloqueado) return;
  audioDesbloqueado = true;
  [reproductor, musicaFondoEl].forEach(el => {
    if (!el) return;
    const volOriginal = el.volume;
    el.volume = 0;
    el.play().then(() => { el.pause(); el.currentTime = 0; el.volume = volOriginal; })
      .catch(() => { el.volume = volOriginal; });
  });
}

function iniciarMusicaFondo() {
  if (!musicaFondoEl || audioSilenciado) return;
  const pista = MUSICA_FONDO[Math.floor(Math.random() * MUSICA_FONDO.length)];
  musicaFondoEl.src = pista;
  musicaFondoEl.volume = 0.15;
  musicaFondoEl.play().catch((e) => {
    console.warn("⚠️ No se pudo reproducir la música de fondo:", e);
  });
}

function detenerMusicaFondo() {
  if (!musicaFondoEl) return;
  musicaFondoEl.pause();
  musicaFondoEl.currentTime = 0;
}

function pausarMusicaFondo() {
  if (!musicaFondoEl || musicaFondoEl.paused) return;
  musicaFondoEl.pause(); // mantiene currentTime, no resetea
}

function reanudarMusicaFondo() {
  if (!musicaFondoEl || !musicaFondoEl.src) return;
  musicaFondoEl.play().catch(() => {});
}

let pasosMeditacion = [];
let cacheAudioMeditacion = {}; // { indice: audio_base64 } — se completa bajo demanda
let indicePasoMeditacion = 0;
let timerMeditacionId = null;
let preguntaCierreMeditacion = "";

document.getElementById("btn-saltear-meditacion")?.addEventListener("click", () => {
  clearTimeout(timerMeditacionId);
  detenerMusicaFondo();
  borrarProgresoMeditacion();
  registrarEvento("Meditación salteada antes de terminar.");
  iniciarChatConversacional(preguntaCierreMeditacion);
});

// FIX LAZY: pide el audio premium de un paso puntual, solo cuando hace
// falta. Se usa tanto para el paso actual (si todavía no se prefeteó)
// como para prefetechar el siguiente en segundo plano.
async function fetchAudioPaso(texto) {
  if (!texto || audioSilenciado) return "";
  try {
    const form = new FormData();
    form.append("texto", texto);
    const resp = await fetch(`${API_BASE}/meditacion/audio-paso`, { method: "POST", body: form });
    const data = await resp.json();
    return data.audio_base64 || "";
  } catch (e) {
    return "";
  }
}

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
      audio_intro_base64: "",
    };
  }

  estado.categoriaAnimoActual = data.categoria || "pausa";

  pasosMeditacion = data.pasos || [];
  cacheAudioMeditacion = {};
  preguntaCierreMeditacion = data.pregunta_cierre || "¿Cómo te quedaste con esto?";
  indicePasoMeditacion = -1;

  document.getElementById("eyebrow-meditacion").textContent =
    `${ETIQUETAS_DOMINIO[estado.dominioActual]} — Meditación guiada`;

  registrarEvento(`Meditación iniciada: ${data.intro || ""}`);
  pintarPuntosMeditacion();
  mostrarPantalla("pantalla-meditacion");
  iniciarMusicaFondo();

  // Prefetch del paso 1 en paralelo mientras suena la intro — así, cuando
  // termine la intro, el audio del primer paso ya está (casi siempre) listo.
  if (pasosMeditacion[0]) {
    fetchAudioPaso(pasosMeditacion[0].texto).then(b64 => { cacheAudioMeditacion[0] = b64; });
  }

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

// -----------------------------------------------------------------
// FIX punto 6: RETOMAR MEDITACIÓN DONDE QUEDÓ.
// Antes, si el celular recargaba la pestaña de fondo (muy común en
// Chrome mobile cuando la app queda en segundo plano varios minutos) o
// se cortaba la conexión, se perdía todo el estado de JS y la meditación
// arrancaba de cero al volver. Ahora cada paso que avanza se guarda en
// sessionStorage (dura mientras la pestaña esté abierta, se borra sola
// al cerrarla — no dura para siempre como localStorage). Si la página
// se recarga y hay una meditación sin terminar, se retoma automático
// desde el mismo paso en el que se quedó, sin volver a pedirle nada a
// Gemini (los pasos ya generados quedan guardados tal cual).
// -----------------------------------------------------------------
function guardarProgresoMeditacion() {
  try {
    sessionStorage.setItem("im_meditacion_en_curso", JSON.stringify({
      pasos: pasosMeditacion,
      indice: indicePasoMeditacion,
      preguntaCierre: preguntaCierreMeditacion,
      dominio: estado.dominioActual,
      herramienta: estado.herramientaActual,
      nombreUsuario: estado.nombreUsuario,
      relatoTexto: estado.relatoTexto,
      categoriaAnimo: estado.categoriaAnimoActual,
    }));
  } catch (e) { /* sin sessionStorage disponible: sigue sin retomado */ }
}

function borrarProgresoMeditacion() {
  try { sessionStorage.removeItem("im_meditacion_en_curso"); } catch (e) {}
}

async function avanzarPasoMeditacion() {
  clearTimeout(timerMeditacionId);
  indicePasoMeditacion++;
  pintarPuntosMeditacion();
  guardarProgresoMeditacion();

  const circulo = document.getElementById("meditacion-circulo");
  const textoEl = document.getElementById("meditacion-texto-paso");

  if (indicePasoMeditacion >= pasosMeditacion.length) {
    registrarEvento("Meditación finalizada.");
    borrarProgresoMeditacion();
    iniciarChatConversacional(preguntaCierreMeditacion);
    return;
  }

  const paso = pasosMeditacion[indicePasoMeditacion];
  textoEl.textContent = paso.texto;
  circulo?.classList.add("respirando");

  // Prefetch del PRÓXIMO paso en paralelo, para que esté listo cuando
  // termine el actual (esto es lo que hace que saltar entre pasos no
  // sienta demora, aunque cada audio se genere recién cuando hace falta).
  const siguiente = pasosMeditacion[indicePasoMeditacion + 1];
  if (siguiente && cacheAudioMeditacion[indicePasoMeditacion + 1] === undefined) {
    fetchAudioPaso(siguiente.texto).then(b64 => { cacheAudioMeditacion[indicePasoMeditacion + 1] = b64; });
  }

  // Si el audio de ESTE paso todavía no llegó del prefetch anterior, se
  // pide ahora mismo (caso borde: la persona avanzó más rápido de lo normal).
  let audioB64 = cacheAudioMeditacion[indicePasoMeditacion];
  if (audioB64 === undefined) {
    audioB64 = await fetchAudioPaso(paso.texto);
    cacheAudioMeditacion[indicePasoMeditacion] = audioB64;
  }

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

// -----------------------------------------------------------------
// AVISO SUAVE DE TIEMPO EN EL CHAT — a los 120s sin que la persona
// envíe nada, aparece un texto chico y gris (no un modal, no interrumpe)
// con la opción de finalizar si quiere. Se reinicia con cada mensaje.
// -----------------------------------------------------------------
let temporizadorAvisoChatId = null;

function iniciarTemporizadorAvisoChat() {
  clearTimeout(temporizadorAvisoChatId);
  ocultarAvisoTiempoChat();
  temporizadorAvisoChatId = setTimeout(() => {
    document.getElementById("chat-aviso-tiempo")?.classList.remove("oculto");
    requestAnimationFrame(() => {
      document.getElementById("chat-aviso-tiempo")?.classList.add("visible");
    });
  }, 120000);
}

function ocultarAvisoTiempoChat() {
  const avisoEl = document.getElementById("chat-aviso-tiempo");
  avisoEl?.classList.remove("visible");
  avisoEl?.classList.add("oculto");
}

document.getElementById("btn-chat-aviso-finalizar")?.addEventListener("click", () => {
  clearTimeout(temporizadorAvisoChatId);
  mostrarPantalla("pantalla-confirmar-cierre");
});

// -----------------------------------------------------------------
// FIX FLUIDEZ: antes, después de "Ejercicio del momento" había una
// pantalla aparte ("Aprendiendo acerca de:") con su propio botón
// Continuar, y recién ahí arrancaba el chat. Ahora todo pasa DENTRO del
// chat: si la persona compartió algo en el cuadro de texto del ejercicio,
// aparece primero como si fuera un mensaje suyo; después la IA entrega el
// fundamento y la pregunta de seguimiento como dos burbujas seguidas, con
// voz normal (Edge-TTS) — se siente una sola conversación continua, no
// tres pantallas pegadas.
// -----------------------------------------------------------------
function iniciarChatDesdeEjercicio(textoCompartido) {
  chatEnCurso = true;
  mostrarPantalla("pantalla-chat");
  const chatEl = document.getElementById("chat-mensajes");
  if (chatEl) chatEl.innerHTML = "";
  chatHistorial.length = 0;
  iniciarTemporizadorAvisoChat();

  const btnFinalizar = document.getElementById("btn-chat-finalizar");
  if (btnFinalizar) {
    btnFinalizar.classList.remove("oculto");
    btnFinalizar.textContent = "Continuar";
    btnFinalizar.classList.add("btn-primario");
    btnFinalizar.classList.remove("btn-secundario");
  }

  const data = estado.ejercicioActualDetalle || {};
  const fundamento = data.fundamento || "Este ejercicio te invita a habitar el momento presente.";
  const pregunta = data.pregunta_seguimiento || "¿Cómo te quedaste con esto? ¿Qué notás ahora?";

  if (textoCompartido) {
    agregarBurbuja("usuario", textoCompartido);
    chatHistorial.push({ rol: "usuario", texto: textoCompartido });
  }

  const burbujaFundamento = agregarBurbuja("ia", fundamento, data.audio_fundamento_base64);
  chatHistorial.push({ rol: "ia", texto: fundamento });
  registrarEvento(`ÍntegraMENTE (fundamento): ${fundamento}`);

  const continuarConPregunta = () => {
    // Pausa real antes de la pregunta — antes aparecía pegada al
    // fundamento apenas terminaba el audio (o de inmediato si no había
    // audio), y se sentía como un solo bloque de texto en vez de dos
    // momentos distintos de una charla.
    setTimeout(() => {
      const burbujaPregunta = agregarBurbuja("ia", pregunta, data.audio_pregunta_seguimiento_base64);
      chatHistorial.push({ rol: "ia", texto: pregunta });
      registrarEvento(`ÍntegraMENTE: ${pregunta}`);
      if (data.audio_pregunta_seguimiento_base64 && !audioSilenciado && burbujaPregunta?.btn) {
        _reproducirAudioBurbuja(burbujaPregunta.btn, burbujaPregunta.estadoAudio);
      }
      guardarSesionEnLocalStorage();
    }, 900);
  };

  if (data.audio_fundamento_base64 && !audioSilenciado && burbujaFundamento?.btn) {
    _reproducirAudioBurbuja(burbujaFundamento.btn, burbujaFundamento.estadoAudio, continuarConPregunta);
  } else {
    setTimeout(continuarConPregunta, 600);
  }
}

function iniciarChatConversacional(preguntaInicial) {
  chatEnCurso = true;
  mostrarPantalla("pantalla-chat");
  const chatEl = document.getElementById("chat-mensajes");
  if (chatEl) chatEl.innerHTML = "";
  chatHistorial.length = 0;
  iniciarTemporizadorAvisoChat();

  const btnFinalizar = document.getElementById("btn-chat-finalizar");
  if (btnFinalizar) {
    // Siempre visible desde el principio — la persona puede avanzar
    // o retroceder cuando quiera, sin esperar a nada.
    btnFinalizar.classList.remove("oculto");
    btnFinalizar.textContent = "Continuar";
    btnFinalizar.classList.add("btn-primario");
    btnFinalizar.classList.remove("btn-secundario");
  }

  const pregunta = preguntaInicial || "¿Cómo te quedaste con esto? ¿Qué notás ahora?";

  const burbuja = agregarBurbuja("ia", pregunta);
  chatHistorial.push({ rol: "ia", texto: pregunta });
  registrarEvento(`ÍntegraMENTE: ${pregunta}`);

  if (!audioSilenciado && burbuja?.btn) {
    _reproducirAudioBurbuja(burbuja.btn, burbuja.estadoAudio);
  }

  guardarSesionEnLocalStorage();
}

// -----------------------------------------------------------------
// FIX: botón "Escuchar" en CADA respuesta de la IA en el chat — existía
// antes en algunas pantallas y se había perdido en el chat general. Un
// solo mecanismo para las tres situaciones: reproducir automático al
// llegar el mensaje, reproducir a demanda si la persona lo toca después,
// y frenar si lo toca de nuevo mientras está sonando (toggle).
// -----------------------------------------------------------------
let _botonAudioBurbujaActivo = null;
let _alTerminarAudioBurbujaActivo = null;

function _finalizarAudioBurbuja(btn) {
  if (_botonAudioBurbujaActivo === btn) {
    _botonAudioBurbujaActivo = null;
    const cb = _alTerminarAudioBurbujaActivo;
    _alTerminarAudioBurbujaActivo = null;
    if (btn) btn.textContent = "🔊 Escuchar";
    if (cb) cb();
  } else if (btn) {
    btn.textContent = "🔊 Escuchar";
  }
}

async function _reproducirAudioBurbuja(btn, estadoAudio, alTerminar) {
  if (_botonAudioBurbujaActivo === btn) {
    // Ya está sonando esta burbuja — la toco de nuevo para pararla.
    reproductor.pause();
    reproductor.currentTime = 0;
    _finalizarAudioBurbuja(btn);
    return;
  }
  if (_botonAudioBurbujaActivo) {
    // Había otra burbuja sonando — se corta antes de arrancar la nueva.
    const anterior = _botonAudioBurbujaActivo;
    reproductor.pause();
    _finalizarAudioBurbuja(anterior);
  }
  if (audioSilenciado) return;
  btn.disabled = true;
  btn.textContent = "Cargando...";
  if (!estadoAudio.audio) {
    try {
      const form = new FormData();
      form.append("texto", estadoAudio.texto);
      const resp = await fetch(`${API_BASE}/tts`, { method: "POST", body: form });
      const data = await resp.json();
      estadoAudio.audio = data.audio_base64 || "";
    } catch (e) {
      estadoAudio.audio = "";
    }
  }
  btn.disabled = false;
  if (!estadoAudio.audio) { btn.textContent = "🔊 Escuchar"; return; }
  _botonAudioBurbujaActivo = btn;
  _alTerminarAudioBurbujaActivo = alTerminar || null;
  btn.textContent = "⏸ Parar";
  reproductor.onended = () => _finalizarAudioBurbuja(btn);
  reproductor.onerror = () => _finalizarAudioBurbuja(btn);
  reproductor.src = "data:audio/mpeg;base64," + estadoAudio.audio;
  reproductor.play().catch(() => _finalizarAudioBurbuja(btn));
}

function agregarBurbuja(rol, texto, audioB64) {
  const chatEl = document.getElementById("chat-mensajes");
  if (!chatEl) return null;
  const div = document.createElement("div");
  div.className = `burbuja burbuja-${rol}`;
  const p = document.createElement("p");
  p.textContent = texto;
  div.appendChild(p);

  let btn = null;
  const estadoAudio = { audio: audioB64 || null, texto };
  if (rol === "ia") {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-audio-burbuja";
    btn.textContent = "🔊 Escuchar";
    btn.addEventListener("click", () => _reproducirAudioBurbuja(btn, estadoAudio));
    div.appendChild(btn);
  }

  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return { btn, estadoAudio };
}

async function enviarMensajeChat() {
  const inputEl = document.getElementById("chat-input-texto");
  const mensaje = inputEl?.value?.trim();
  if (!mensaje) return;
  inputEl.value = "";
  iniciarTemporizadorAvisoChat();
  document.getElementById("btn-enviar-chat")?.classList.add("oculto");
  document.getElementById("btn-grabar-chat")?.classList.remove("oculto");

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
    const burbuja = agregarBurbuja("ia", data.texto, data.audio_base64);
    chatHistorial.push({ rol: "ia", texto: data.texto });
    registrarEvento(`Persona: ${mensaje}`);
    registrarEvento(`ÍntegraMENTE: ${data.texto}`);
    guardarSesionEnLocalStorage();

    if (data.audio_base64 && !audioSilenciado && burbuja?.btn) {
      _reproducirAudioBurbuja(burbuja.btn, burbuja.estadoAudio);
    }

    if (data.sugiere_herramienta) {
      mostrarTarjetaSugerenciaHerramienta(data.sugiere_herramienta);
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

document.getElementById("chat-input-texto")?.addEventListener("input", (e) => {
  const tieneTexto = e.currentTarget.value.trim().length > 0;
  document.getElementById("btn-grabar-chat")?.classList.toggle("oculto", tieneTexto);
  document.getElementById("btn-enviar-chat")?.classList.toggle("oculto", !tieneTexto);
});

document.getElementById("btn-enviar-chat")?.addEventListener("click", enviarMensajeChat);

// =================================================================
// BITÁCORA EN DOS PASOS — consigna primero, "date cuenta" + frase
// poderosa recién después de que la persona escribe.
// =================================================================
async function iniciarBitacora() {
  mostrarPantalla("pantalla-analisis");
  const variante = estado.historialEjercicios[estado.dominioActual]["bitacora"];

  const form = new FormData();
  form.append("dominio", estado.dominioActual);
  form.append("relato_texto", estado.relatoTexto);
  form.append("variante_idx", variante);

  let data;
  try {
    const resp = await fetch(`${API_BASE}/bitacora/consigna`, { method: "POST", body: form });
    data = await resp.json();
  } catch (e) {
    data = { consigna: "Escribí libremente lo que estás sintiendo hoy, sin filtro.", audio_consigna_base64: "" };
  }

  estado.historialEjercicios[estado.dominioActual]["bitacora"]++;
  estado.bitacoraConsignaActual = data.consigna;
  registrarEvento(`Consigna de bitácora: ${data.consigna}`);

  document.getElementById("eyebrow-bitacora").textContent =
    `Bitácora en curso: ${ETIQUETAS_DOMINIO[estado.dominioActual]}`;
  document.getElementById("texto-consigna-bitacora").textContent = data.consigna;
  document.getElementById("input-bitacora").value = "";
  document.getElementById("btn-reproducir-consigna-bitacora").onclick =
    (e) => reproducirAudioBase64(data.audio_consigna_base64, e.currentTarget);

  mostrarPantalla("pantalla-bitacora-consigna");

  if (data.audio_consigna_base64 && !audioSilenciado) {
    reproducirAudioBase64(data.audio_consigna_base64, document.getElementById("btn-reproducir-consigna-bitacora"));
  }
}

// -----------------------------------------------------------------
// GRABACIÓN DE VOZ EN LA BITÁCORA — mismo criterio que el chat: la
// transcripción SOLO llena el textarea, nunca se envía sola.
// -----------------------------------------------------------------
let grabandoBitacora = false;
let transcribiendoBitacora = false;
let mediaRecorderBitacora = null;
let chunksBitacora = [];

document.getElementById("btn-grabar-bitacora")?.addEventListener("click", async function () {
  const btnGrabar = this;
  const estadoEl = document.getElementById("bitacora-estado-grabacion");
  const svgMic = document.getElementById("svg-mic-bitacora-icono");
  const svgGrabando = document.getElementById("svg-mic-bitacora-grabando");

  // Mientras se transcribe la anterior, el botón no hace nada.
  if (transcribiendoBitacora) return;

  if (!grabandoBitacora) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksBitacora = [];
      mediaRecorderBitacora = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderBitacora.ondataavailable = e => { if (e.data.size > 0) chunksBitacora.push(e.data); };
      mediaRecorderBitacora.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        // Vuelve al ícono de micrófono normal...
        svgMic?.classList.remove("oculto");
        svgGrabando?.classList.add("oculto");

        // ...pero entra en estado "procesando": botón atenuado, bloqueado
        // al toque, y texto explícito de que se está transcribiendo el
        // audio. Antes acá no había nada visible mientras se esperaba la
        // respuesta del servidor, y parecía que la grabación se había
        // perdido o que la app se había colgado.
        transcribiendoBitacora = true;
        btnGrabar.classList.add("procesando");
        btnGrabar.disabled = true;
        if (estadoEl) {
          estadoEl.textContent = "Procesando...";
          estadoEl.classList.remove("oculto");
        }

        const blob = new Blob(chunksBitacora, { type: "audio/webm" });
        const file = new File([blob], "bitacora.webm", { type: "audio/webm" });
        const form = new FormData();
        form.append("audio", file);
        const { texto } = await fetch(`${API_BASE}/transcribir`, {
          method: "POST", body: form,
        }).then(r => r.json()).catch(() => ({ texto: "" }));

        // Se levanta el bloqueo pase lo que pase (éxito o error de red).
        transcribiendoBitacora = false;
        btnGrabar.classList.remove("procesando");
        btnGrabar.disabled = false;
        if (estadoEl) estadoEl.classList.add("oculto");

        // FIX CRÍTICO (mismo criterio que el chat): la transcripción SOLO
        // llena el textarea. El envío queda siempre en manos de la persona.
        if (texto) {
          const inputEl = document.getElementById("input-bitacora");
          if (inputEl) {
            inputEl.value = (inputEl.value ? inputEl.value + " " : "") + texto;
          }
        }
      };
      mediaRecorderBitacora.start(200);
      grabandoBitacora = true;
      btnGrabar.classList.add("grabando");
      svgMic?.classList.add("oculto");
      svgGrabando?.classList.remove("oculto");
      if (estadoEl) {
        estadoEl.textContent = "Grabando";
        estadoEl.classList.remove("oculto");
      }
      setTimeout(() => { if (grabandoBitacora) btnGrabar.click(); }, 30000);
    } catch (e) {
      alert("No se pudo acceder al micrófono.");
    }
  } else {
    if (estadoEl) estadoEl.textContent = "Deteniendo...";
    mediaRecorderBitacora?.stop();
    grabandoBitacora = false;
    btnGrabar.classList.remove("grabando");
  }
});

document.getElementById("btn-enviar-bitacora")?.addEventListener("click", async () => {
  const texto = document.getElementById("input-bitacora")?.value?.trim();
  if (!texto) return;
  registrarEvento(`Registro de bitácora: "${texto}"`);

  mostrarPantalla("pantalla-analisis");

  const form = new FormData();
  form.append("dominio", estado.dominioActual);
  form.append("consigna", estado.bitacoraConsignaActual || "");
  form.append("texto_usuario", texto);

  let data;
  try {
    const resp = await fetch(`${API_BASE}/bitacora/insight`, { method: "POST", body: form });
    data = await resp.json();
  } catch (e) {
    data = {
      insight: "Lo que escribiste tiene el primer paso adentro, aunque todavía no lo veas del todo.",
      frase_poderosa: "Voy a mi ritmo, y eso también es avanzar.",
      frase_explicacion: "",
      audio_insight_base64: "", audio_frase_base64: "",
    };
  }

  estado.fraseAActualPoderosa = data;
  registrarEvento(`Date cuenta: ${data.insight}`);
  registrarEvento(`Frase poderosa: "${data.frase_poderosa}"`);
  guardarFrasePoderosaEnLocalStorage(data.frase_poderosa, data.frase_explicacion);

  document.getElementById("tarjeta-insight-bitacora")?.classList.remove("oculto");
  document.getElementById("texto-insight-bitacora").textContent = data.insight;
  document.getElementById("btn-reproducir-insight-bitacora").onclick =
    (e) => reproducirAudioBase64(data.audio_insight_base64, e.currentTarget);
  document.getElementById("texto-frase-poderosa").textContent = data.frase_poderosa;
  document.getElementById("texto-frase-explicacion").textContent = data.frase_explicacion || "";
  document.getElementById("btn-reproducir-frase-poderosa").onclick =
    (e) => reproducirAudioBase64(data.audio_frase_base64, e.currentTarget);
  document.getElementById("btn-continuar-bitacora")?.classList.remove("oculto");

  // FIX FLUIDEZ: antes "Tu frase poderosa" aparecía pegada al insight, sin
  // transición, y se sentía como dos cosas sueltas. Ahora se oculta hasta
  // que aparece una frase puente y pasan 3s, dando sensación de secuencia.
  const puenteEl = document.getElementById("texto-puente-frase");
  const tarjetaFraseEl = document.getElementById("tarjeta-frase-poderosa");
  puenteEl?.classList.add("oculto");
  tarjetaFraseEl?.classList.add("oculto");

  mostrarPantalla("pantalla-bitacora-insight");

  const revelarFrasePoderosa = () => {
    puenteEl?.classList.remove("oculto");
    setTimeout(() => {
      tarjetaFraseEl?.classList.remove("oculto");
      if (data.audio_frase_base64 && !audioSilenciado) {
        reproducirAudioAutomatico(data.audio_frase_base64, () => {});
      }
    }, 3000);
  };

  if (!audioSilenciado && data.audio_insight_base64) {
    reproducirAudioAutomatico(data.audio_insight_base64, revelarFrasePoderosa);
  } else {
    setTimeout(revelarFrasePoderosa, 800);
  }
});

document.getElementById("btn-continuar-bitacora")?.addEventListener("click", () => {
  const frase = estado.fraseAActualPoderosa?.frase_poderosa || "";
  const pregunta = frase
    ? `¿Cómo te hace sentir esta frase: "${frase}"?`
    : "¿Cómo te quedaste con esto que escribiste?";
  iniciarChatConversacional(pregunta);
});

function mostrarTarjetaSugerenciaHerramienta(herramienta) {
  const ICONOS_HERRAMIENTA = { practica_guiada: "⏱️", microaudio: "🧘‍♀️", bitacora: "✍️" };
  const chatEl = document.getElementById("chat-mensajes");
  if (!chatEl) return;
  const div = document.createElement("div");
  div.className = "tarjeta-sugerencia-herramienta";
  div.innerHTML = `
    <span class="tsh-icono">${ICONOS_HERRAMIENTA[herramienta] || "✨"}</span>
    <span class="tsh-texto">${ETIQUETAS_HERRAMIENTA[herramienta] || herramienta}</span>
    <button class="tsh-boton">Probar esto →</button>
  `;
  div.querySelector(".tsh-boton").addEventListener("click", () => {
    estado.herramientaActual = herramienta;
    registrarEvento(`Herramienta sugerida y elegida desde el chat: ${ETIQUETAS_HERRAMIENTA[herramienta] || herramienta}.`);
    if (herramienta === "microaudio") pedirMeditacion();
    else if (herramienta === "bitacora") iniciarBitacora();
    else pedirEjercicio();
  });
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// FIX CRÍTICO: se saca el envío con Enter. En mobile, el teclado
// virtual puede disparar un keydown de Enter real (botón "Ir"/"Enviar"
// del teclado) sin que la persona lo haga a propósito — sobre todo
// estando el dedo cerca del botón de micrófono, al lado del campo de
// texto. Esto podía mandar un mensaje sin que la persona lo confirmara
// explícitamente, violando la regla de "nunca se envía sin tocar
// Enviar". Ahora la ÚNICA forma de enviar es tocando el botón.

// Grabación de voz en el chat (mismo patrón que la grabación de audio del canal)
let grabandoChat = false;
let mediaRecorderChat = null;
let chunksChat = [];
// FIX GRABACIÓN: mientras la última grabación todavía se está transcribiendo,
// el botón queda bloqueado — antes volvía a verse "normal" de inmediato y la
// persona lo tocaba de nuevo pensando que no había pasado nada, lo que
// arrancaba una segunda grabación antes de que la primera terminara de
// enviarse (esa era la causa real de "tarda mucho" / "queda pegada").
let transcribiendoChat = false;

function limpiarGrabacionChatPendiente() {
  // Se llama al salir de la pantalla de chat: si había una grabación en
  // curso se corta, y cualquier transcripción sin enviar en el cuadro de
  // texto se descarta — así no reaparece "pegada" al volver más tarde.
  if (grabandoChat && mediaRecorderChat && mediaRecorderChat.state !== "inactive") {
    mediaRecorderChat.stop();
  }
  grabandoChat = false;
  transcribiendoChat = false;
  const btnGrabarChat = document.getElementById("btn-grabar-chat");
  btnGrabarChat?.classList.remove("grabando", "procesando");
  if (btnGrabarChat) btnGrabarChat.disabled = false;
  document.getElementById("svg-mic-icono")?.classList.remove("oculto");
  document.getElementById("svg-mic-grabando")?.classList.add("oculto");
  const estadoEl = document.getElementById("chat-estado-grabacion");
  if (estadoEl) estadoEl.classList.add("oculto");
  const inputEl = document.getElementById("chat-input-texto");
  if (inputEl && inputEl.value) {
    inputEl.value = "";
    inputEl.dispatchEvent(new Event("input"));
  }
}

document.getElementById("btn-grabar-chat")?.addEventListener("click", async function () {
  const btnGrabarChat = this;
  const estadoEl = document.getElementById("chat-estado-grabacion");
  const svgMic = document.getElementById("svg-mic-icono");
  const svgGrabando = document.getElementById("svg-mic-grabando");

  // Mientras se transcribe la anterior, el botón no hace nada.
  if (transcribiendoChat) return;

  if (!grabandoChat) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksChat = [];
      mediaRecorderChat = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderChat.ondataavailable = e => { if (e.data.size > 0) chunksChat.push(e.data); };
      mediaRecorderChat.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        // Vuelve al ícono de micrófono normal...
        svgMic?.classList.remove("oculto");
        svgGrabando?.classList.add("oculto");

        // ...pero entra en estado "procesando": botón atenuado, bloqueado
        // al toque, y texto explícito de que se está mandando el audio.
        // Esto es lo que faltaba — antes acá no había NADA visible y
        // parecía que la app se había quedado tildada.
        transcribiendoChat = true;
        btnGrabarChat.classList.add("procesando");
        btnGrabarChat.disabled = true;
        if (estadoEl) {
          estadoEl.textContent = "Procesando...";
          estadoEl.classList.remove("oculto");
        }

        const blob = new Blob(chunksChat, { type: "audio/webm" });
        const file = new File([blob], "chat.webm", { type: "audio/webm" });
        const form = new FormData();
        form.append("audio", file);
        const { texto } = await fetch(`${API_BASE}/transcribir`, {
          method: "POST", body: form,
        }).then(r => r.json()).catch(() => ({ texto: "" }));

        // Se levanta el bloqueo pase lo que pase (éxito o error de red).
        transcribiendoChat = false;
        btnGrabarChat.classList.remove("procesando");
        btnGrabarChat.disabled = false;
        if (estadoEl) estadoEl.classList.add("oculto");

        // FIX CRÍTICO: la transcripción SOLO llena el cuadro de texto.
        // Nunca se envía sola — ni acá ni en el corte automático a los
        // 30s de abajo. El envío queda siempre en manos de la persona,
        // tocando "Enviar" ella misma. Esto evita que una transcripción
        // alucinada (silencio o ruido de fondo mal interpretado) se
        // mande como si fuera una respuesta real sin que nadie la vea.
        if (texto) {
          const inputEl = document.getElementById("chat-input-texto");
          if (inputEl) {
            inputEl.value = texto;
            inputEl.dispatchEvent(new Event("input"));
          }
        }
      };
      mediaRecorderChat.start(200);
      grabandoChat = true;
      btnGrabarChat.classList.add("grabando");
      // FIX: el ÍCONO cambia (mic → cuadrado de grabación), no solo el
      // color — y el texto queda pegado al botón, no perdido más abajo.
      svgMic?.classList.add("oculto");
      svgGrabando?.classList.remove("oculto");
      if (estadoEl) {
        estadoEl.textContent = "Grabando";
        estadoEl.classList.remove("oculto");
      }
      // Corte de seguridad a los 30s: solo detiene la grabación (para no
      // dejar el micrófono abierto indefinidamente), NUNCA envía nada.
      setTimeout(() => { if (grabandoChat) btnGrabarChat.click(); }, 30000);
    } catch (e) {
      alert("No se pudo acceder al micrófono.");
    }
  } else {
    if (estadoEl) estadoEl.textContent = "Deteniendo...";
    mediaRecorderChat?.stop();
    grabandoChat = false;
    btnGrabarChat.classList.remove("grabando");
  }
});

document.getElementById("btn-chat-finalizar")?.addEventListener("click", () => {
  document.getElementById("btn-chat-finalizar")?.classList.add("oculto");
  ocultarAvisoTiempoChat();
  clearTimeout(temporizadorAvisoChatId);
  mostrarRuteoInlineEnChat();
});

// -----------------------------------------------------------------
// RUTEO INLINE — reemplaza la pantalla aparte de "¿cómo seguimos?"
// por una frase de la IA + los mismos íconos redondos de la marca,
// directamente dentro del chat, en la misma pantalla.
// -----------------------------------------------------------------
function mostrarRuteoInlineEnChat() {
  const chatEl = document.getElementById("chat-mensajes");
  if (!chatEl) return;

  agregarBurbuja("ia", "¿Con qué te gustaría seguir?");

  const cont = document.createElement("div");
  cont.className = "opciones-circulares opciones-circulares-inline";
  cont.innerHTML = `
    <button type="button" class="btn-circular" id="ruteo-inline-herramienta">
      <span class="circulo">🔁</span><span class="etiqueta">Otra herramienta</span>
    </button>
    <button type="button" class="btn-circular" id="ruteo-inline-dominio">
      <span class="circulo">🔄</span><span class="etiqueta">Cambiar de dominio</span>
    </button>
    <button type="button" class="btn-circular" id="ruteo-inline-finalizar">
      <span class="circulo">✓</span><span class="etiqueta">Finalizar</span>
    </button>
  `;
  chatEl.appendChild(cont);
  chatEl.scrollTop = chatEl.scrollHeight;

  cont.querySelector("#ruteo-inline-herramienta").addEventListener("click", () => {
    registrarEvento("Elige probar otra herramienta en el mismo dominio.");
    mostrarPantallaHerramientas();
  });
  cont.querySelector("#ruteo-inline-dominio").addEventListener("click", () => {
    registrarEvento("Elige cambiar de dominio.");
    mostrarPantalla("pantalla-devolucion");
  });
  cont.querySelector("#ruteo-inline-finalizar").addEventListener("click", () => {
    mostrarPantalla("pantalla-reporte");
    generarReporteAutomatico();
  });
}

// =================================================================
// LOCALSTORAGE — recordar sesiones anteriores (solo local, sin backend)
// =================================================================
// -----------------------------------------------------------------
// FIX punto 9 (parte 1): SESIONES COMPLETAS VS INCOMPLETAS.
// "Sesión" acá es cada vez que alguien inicia sesión en la app — no cada
// herramienta usada (eso ya lo cuenta im_sesion_ por separado). Se marca
// "iniciada" apenas hace login/registro, y "completa" recién si llega a
// la pantalla de cierre (mismo momento en que se genera el reporte). Las
// que quedaron "iniciada" sin pasar a "completa" son las que la persona
// abandonó en el medio — no hay forma de detectar el abandono en el
// momento (no hay código corriendo después de cerrar la pestaña), así
// que se infiere después: total − completas = incompletas.
// -----------------------------------------------------------------
let _sesionAppActualId = null;

function iniciarSesionApp() {
  try {
    const key = "im_sesiones_app_" + (estado.nombreUsuario || "anonimo");
    const sesiones = JSON.parse(localStorage.getItem(key) || "[]");
    _sesionAppActualId = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    sesiones.push({ id: _sesionAppActualId, inicio: new Date().toISOString(), completa: false, fin: null });
    if (sesiones.length > 200) sesiones.shift();
    localStorage.setItem(key, JSON.stringify(sesiones));
  } catch (e) { /* sin localStorage disponible */ }
}

function marcarSesionAppCompletada() {
  if (!_sesionAppActualId) return;
  try {
    const key = "im_sesiones_app_" + (estado.nombreUsuario || "anonimo");
    const sesiones = JSON.parse(localStorage.getItem(key) || "[]");
    const actual = sesiones.find(s => s.id === _sesionAppActualId);
    if (actual) {
      actual.completa = true;
      actual.fin = new Date().toISOString();
      localStorage.setItem(key, JSON.stringify(sesiones));
    }
  } catch (e) { /* sin localStorage disponible */ }
}

function contarSesionesApp() {
  try {
    const key = "im_sesiones_app_" + (estado.nombreUsuario || "anonimo");
    const sesiones = JSON.parse(localStorage.getItem(key) || "[]");
    const completas = sesiones.filter(s => s.completa).length;
    return { total: sesiones.length, completas, incompletas: sesiones.length - completas };
  } catch (e) {
    return { total: 0, completas: 0, incompletas: 0 };
  }
}

function guardarSesionEnLocalStorage() {
  try {
    const key = "im_sesion_" + (estado.nombreUsuario || "anonimo");
    const data = {
      fecha: new Date().toISOString(),
      dominio: estado.dominioActual,
      herramienta: estado.herramientaActual || null,
      energia: estado.energiaActual || "baja",
      categoriaAnimo: estado.categoriaAnimoActual || null,
      categoriaAnimoFinal: estado.categoriaAnimoFinal || null,
      relato: (estado.relatoTexto || "").substring(0, 200),
      historial: chatHistorial.slice(-10),
    };
    const sesiones = JSON.parse(localStorage.getItem(key) || "[]");
    // FIX MÉTRICAS: antes se buscaba una sesión ya guardada del mismo día
    // calendario y se SOBRESCRIBÍA — con varias pruebas en un mismo día,
    // solo quedaba la última, y por eso las métricas mostraban muchas
    // menos sesiones de las que realmente se hicieron. Ahora cada sesión
    // se agrega como un registro nuevo; el límite de 50 sigue evitando que
    // el localStorage crezca sin límite.
    sesiones.push(data);
    if (sesiones.length > 50) sesiones.shift();
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
    day: "numeric", month: "short"
  });
  const saludo = document.getElementById("saludo-usuario");
  if (saludo) {
    const linea1 = saludo.textContent;
    const linea2 = `Última sesión: ${ETIQUETAS_DOMINIO[sesionAnterior.dominio] || sesionAnterior.dominio || ""} (${fecha})`;
    saludo.innerHTML = `<span>${linea1}</span><span>${linea2}</span>`;
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
  const contTarjetas = document.getElementById("metricas-tarjetas");
  const contDominios = document.getElementById("metricas-grafico-dominios");
  const contEnergia  = document.getElementById("metricas-grafico-energia");
  const vacio        = document.getElementById("metricas-vacio");
  if (!contDominios || !contEnergia) return;
  if (contTarjetas) contTarjetas.innerHTML = "";
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

  // --- Tarjetas resumen ---
  const dominioFavorito = Object.entries(conteo).sort((a, b) => b[1] - a[1])[0];
  const ETIQUETAS_ANIMO = {
    estres: "Estrés / activación", autocompasion: "Autocompasión",
    enfoque: "Mente dispersa", alegria: "Alegría", pausa: "Pausa / cansancio",
  };
  const conteoAnimo = {};
  sesiones.forEach(s => { if (s.categoriaAnimo) conteoAnimo[s.categoriaAnimo] = (conteoAnimo[s.categoriaAnimo] || 0) + 1; });
  const animoPredominante = Object.entries(conteoAnimo).sort((a, b) => b[1] - a[1])[0];

  const fechasUnicas = [...new Set(sesiones.map(s => new Date(s.fecha).toDateString()))]
    .map(d => new Date(d)).sort((a, b) => b - a);
  let racha = fechasUnicas.length ? 1 : 0;
  for (let i = 0; i < fechasUnicas.length - 1; i++) {
    const diffDias = Math.round((fechasUnicas[i] - fechasUnicas[i + 1]) / 86400000);
    if (diffDias === 1) racha++; else break;
  }

  const tarjetas = [
    { valor: racha, label: racha === 1 ? "día seguido" : "días seguidos" },
    { valor: ETIQUETAS_DOMINIO[dominioFavorito?.[0]] || "—", label: "Dominio favorito" },
    { valor: sesiones.length, label: sesiones.length === 1 ? "sesión registrada" : "sesiones registradas" },
    { valor: ETIQUETAS_ANIMO[animoPredominante?.[0]] || "—", label: "Ánimo predominante" },
  ];
  if (contTarjetas) {
    tarjetas.forEach(t => {
      const div = document.createElement("div");
      div.className = "metrica-tarjeta";
      div.innerHTML = `<div class="metrica-tarjeta-valor">${t.valor}</div><div class="metrica-tarjeta-label">${t.label}</div>`;
      contTarjetas.appendChild(div);
    });
  }

  // --- FIX punto 9: estado de sesiones (iniciadas / completas / incompletas) ---
  const contSesionesEstado = document.getElementById("metricas-sesiones-estado");
  if (contSesionesEstado) {
    const { total, completas, incompletas } = contarSesionesApp();
    contSesionesEstado.innerHTML = `
      <div class="metricas-sesiones-fila">
        <span class="metrica-tarjeta-valor">${total}</span>
        <span class="metrica-tarjeta-label">${total === 1 ? "sesión iniciada" : "sesiones iniciadas"}</span>
      </div>
      <div class="metricas-sesiones-fila">
        <span class="metrica-tarjeta-valor">${completas}</span>
        <span class="metrica-tarjeta-label">${completas === 1 ? "completa (llegó a Finalizar sesión)" : "completas (llegaron a Finalizar sesión)"}</span>
      </div>
      <div class="metricas-sesiones-fila">
        <span class="metrica-tarjeta-valor">${incompletas}</span>
        <span class="metrica-tarjeta-label">${incompletas === 1 ? "incompleta (se fue antes)" : "incompletas (se fueron antes)"}</span>
      </div>
    `;
  }

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

  // -----------------------------------------------------------------
  // FIX punto 9: GRÁFICO DE ENERGÍA POR FECHA, con matices reales.
  // Eje X = fecha, eje Y = una de las 5 categorías de ánimo (no solo
  // alta/baja). Si en un mismo día hay más de una sesión con la MISMA
  // categoría, se dibuja un solo punto pero más grande (más denso). Si
  // en el mismo día hay categorías DISTINTAS, quedan en filas distintas
  // del eje Y, cada una en su lugar. Para poder distinguir cuál pasó
  // primero: si el punto es único (una sola vez ese día con esa
  // categoría) se le pone la hora arriba; si es varias veces juntas
  // (fusionadas en un solo punto más grande), se pone "×N" en vez de
  // una hora ambigua.
  // -----------------------------------------------------------------
  const ORDEN_ANIMO = ["alegria", "enfoque", "pausa", "autocompasion", "estres"];
  const gruposPorClave = {};
  const fechasVistas = [];
  sesiones.forEach(s => {
    const cat = ORDEN_ANIMO.includes(s.categoriaAnimo) ? s.categoriaAnimo : "pausa";
    const fechaObj = new Date(s.fecha);
    const fechaKey = fechaObj.toLocaleDateString("es-AR", { day: "numeric", month: "short" });
    if (!fechasVistas.includes(fechaKey)) fechasVistas.push(fechaKey);
    const clave = fechaKey + "|" + cat;
    if (!gruposPorClave[clave]) gruposPorClave[clave] = { fechaKey, cat, horas: [] };
    gruposPorClave[clave].horas.push(fechaObj);
  });
  const puntos = Object.values(gruposPorClave);

  if (contEnergia) {
    if (!puntos.length) {
      contEnergia.innerHTML = "";
    } else {
      // Radio de cada burbuja: crece con la cantidad de veces registradas
      // ese día con esa categoría, con un TOPE MÁXIMO (nunca pasa de 18px
      // de radio) para que una racha muy larga no rompa el layout.
      const radioDe = (cantidad) => 6 + Math.min(cantidad - 1, 5) * 2.4;
      const radioMax = Math.max(...puntos.map(p => radioDe(p.horas.length)), 6);
      // extra = cuánto más grande es la burbuja más grande que el caso
      // base (radio 6) — se usa para agrandar los márgenes y la
      // separación entre filas SOLO lo necesario. Con pocas sesiones
      // (radio chico) el gráfico queda compacto, y a medida que se
      // acumulan más sesiones del mismo tipo, todo se corre solo para
      // seguir dejando lugar (espaciado automático + tope combinados).
      const extra = radioMax - 6;
      const PAD_IZQ = 92 + extra, PAD_DER = 24, PAD_TOP = 26 + extra, PAD_BOT = 34;
      const FILA_MIN = 37.5;
      const pasoY = Math.max(FILA_MIN, radioMax * 2 + 14);
      // COLUMNA_MIN = mismo criterio que pasoY pero para el eje horizontal:
      // antes el ancho de columna quedaba fijo en 64px sin importar el
      // tamaño de las burbujas, así que dos fechas seguidas con rachas
      // largas (misma categoría, ambas con el radio tope) terminaban
      // pisándose entre sí. Ahora también crece con la burbuja más grande.
      const COLUMNA_MIN = 64;
      const anchoColumna = Math.max(COLUMNA_MIN, radioMax * 2 + 14);
      const ANCHO = Math.max(360, PAD_IZQ + PAD_DER + fechasVistas.length * anchoColumna);
      const ALTO = PAD_TOP + PAD_BOT + (ORDEN_ANIMO.length - 1) * pasoY;
      const pasoX = fechasVistas.length > 1 ? (ANCHO - PAD_IZQ - PAD_DER) / (fechasVistas.length - 1) : 0;

      let svg = `<svg width="${ANCHO}" height="${ALTO}" viewBox="0 0 ${ANCHO} ${ALTO}" class="metrica-energia-svg" role="img" aria-label="Gráfico de energía por fecha">`;

      ORDEN_ANIMO.forEach((cat, i) => {
        const y = PAD_TOP + i * pasoY;
        svg += `<line x1="${PAD_IZQ}" y1="${y}" x2="${ANCHO - PAD_DER}" y2="${y}" stroke="#E9D9CE" stroke-width="1"/>`;
        svg += `<text x="${PAD_IZQ - 10}" y="${y + 4}" text-anchor="end" class="metrica-energia-svg-eje">${ETIQUETAS_ANIMO[cat].split(" / ")[0].split(" ").slice(0, 2).join(" ")}</text>`;
      });

      fechasVistas.forEach((f, i) => {
        const x = PAD_IZQ + i * pasoX;
        svg += `<text x="${x}" y="${ALTO - 10}" text-anchor="middle" class="metrica-energia-svg-eje">${f}</text>`;
      });

      puntos.forEach(p => {
        const xi = fechasVistas.indexOf(p.fechaKey);
        const yi = ORDEN_ANIMO.indexOf(p.cat);
        const x = PAD_IZQ + xi * pasoX;
        const y = PAD_TOP + yi * pasoY;
        const cantidad = p.horas.length;
        const r = radioDe(cantidad);
        const etiqueta = cantidad > 1
          ? `×${cantidad}`
          : p.horas[0].toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
        svg += `<circle cx="${x}" cy="${y}" r="${r}" class="metrica-energia-svg-punto"/>`;
        svg += `<text x="${x}" y="${y - r - 5}" text-anchor="middle" class="metrica-energia-svg-hora">${etiqueta}</text>`;
      });

      svg += `</svg>`;
      contEnergia.innerHTML = svg;
    }
  }
}



// Al cargar la página, si queda una meditación sin terminar guardada
// (por una recarga de la pestaña o un corte), se retoma sola desde el
// mismo paso — sin volver a pedirle nada a Gemini, los pasos ya
// generados se reusan tal cual quedaron guardados.
(function restaurarMeditacionEnCurso() {
  try {
    const guardado = JSON.parse(sessionStorage.getItem("im_meditacion_en_curso") || "null");
    if (!guardado || !Array.isArray(guardado.pasos) || !guardado.pasos.length) return;
    estado.dominioActual = guardado.dominio;
    estado.herramientaActual = guardado.herramienta;
    estado.nombreUsuario = guardado.nombreUsuario;
    estado.relatoTexto = guardado.relatoTexto;
    estado.categoriaAnimoActual = guardado.categoriaAnimo;
    pasosMeditacion = guardado.pasos;
    cacheAudioMeditacion = {};
    preguntaCierreMeditacion = guardado.preguntaCierre;
    // Se resta 1 porque avanzarPasoMeditacion() empieza incrementando —
    // así el primer avance cae justo en el paso guardado, no en el
    // siguiente (no se salta ningún paso al retomar).
    indicePasoMeditacion = Math.max(-1, (guardado.indice || 0) - 1);
    const eyebrowEl = document.getElementById("eyebrow-meditacion");
    if (eyebrowEl) {
      eyebrowEl.textContent = `${ETIQUETAS_DOMINIO[estado.dominioActual] || estado.dominioActual} — Meditación guiada`;
    }
    pintarPuntosMeditacion();
    mostrarPantalla("pantalla-meditacion");
    iniciarMusicaFondo();
    avanzarPasoMeditacion();
  } catch (e) {
    // Sin sessionStorage disponible o datos corruptos: la app arranca
    // normal, desde la pantalla de bienvenida, sin romper nada.
  }
})();
