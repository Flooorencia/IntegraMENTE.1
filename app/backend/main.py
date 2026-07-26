# =================================================================
# SERVIDOR PRINCIPAL - ÍNTEGRAMENTE
# Versión definitiva — auditada línea por línea.
# Fixes aplicados vs. versión anterior:
#   · Part.from_text("...") → Part.from_text(text="...") [bug confirmado en logs]
#   · mime_valido forzado a "audio/webm" (Android Chrome envía
#     application/octet-stream → Gemini lo rechazaba silenciosamente)
#   · StaticFiles usa path absoluto (evita fallo por CWD en Render)
#   · Motor TTS con doble resguardo: edge-tts → gTTS (sin cambios, ya correcto)
# =================================================================

import io
import os
import base64
import asyncio
import requests
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, JSONResponse
import edge_tts
from gtts import gTTS

from motor_ia import (
    generar_diagnostico, generar_ejercicio, continuar_conversacion,
    generar_meditacion, clasificar_estado_animo,
    generar_consigna_bitacora, generar_insight_bitacora,
)
from reporte_pdf import generar_pdf_reporte

app = FastAPI(title="ÍntegraMENTE API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------------------------------------------
# ELEVENLABS — voz premium, usada SOLO para las meditaciones (para no
# gastar la cuota gratuita mensual en el resto de la conversación).
# Si falta la clave o la llamada falla por cualquier motivo, devuelve
# None y el que llama cae automáticamente a Edge-TTS — la app nunca
# se queda sin voz.
# -----------------------------------------------------------------
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID")  # se define SOLO en Render; sin esto, la meditación usa Edge-TTS

# FIX 429 "concurrent_limit_exceeded": la meditación pide varios audios a
# la vez con asyncio.gather (intro + pregunta de cierre + cada paso), y el
# plan gratuito de ElevenLabs solo permite 2 pedidos simultáneos por cuenta.
# Este semáforo serializa las llamadas reales a ElevenLabs (1 a la vez, con
# margen de sobra bajo el límite de 2) sin tocar en nada la lógica de
# asyncio.gather que ya arma los audios en paralelo — cada llamada solo
# espera su turno antes de salir a la red.
_ELEVENLABS_SEMAFORO = asyncio.Semaphore(1)


def _generar_audio_elevenlabs(texto: str) -> Optional[bytes]:
    if not ELEVENLABS_API_KEY or not ELEVENLABS_VOICE_ID or not texto or not texto.strip():
        return None
    try:
        resp = requests.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}",
            headers={"xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json"},
            json={
                "text": texto,
                "model_id": "eleven_multilingual_v2",
                "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
            },
            timeout=20,
        )
        if resp.status_code == 200:
            return resp.content
        print(f"⚠️ ElevenLabs devolvió {resp.status_code}: {resp.text[:200]}")
        return None
    except Exception as e:
        print(f"⚠️ ElevenLabs falló, cae a Edge-TTS: {e}")
        return None

# -----------------------------------------------------------------
# TTS: texto → audio base64
# Motor principal: edge-tts (es-AR-ElenaNeural, voz neuronal argentina).
# Motor de resguardo automático: gTTS, se activa si edge-tts falla
# o devuelve audio vacío. La app NUNCA queda en silencio.
# -----------------------------------------------------------------
VOZ_RIOPLATENSE = "es-AR-ElenaNeural"


async def _edge_tts(texto: str) -> bytes:
    com = edge_tts.Communicate(texto, voice=VOZ_RIOPLATENSE)
    buf = io.BytesIO()
    async for chunk in com.stream():
        if chunk["type"] == "audio":
            buf.write(chunk["data"])
    buf.seek(0)
    datos = buf.read()
    if not datos:
        raise RuntimeError("edge-tts devolvió audio vacío")
    return datos


def _gtts_sync(texto: str) -> bytes:
    """Resguardo síncrono — se ejecuta en hilo aparte vía asyncio.to_thread."""
    buf = io.BytesIO()
    gTTS(text=texto, lang="es", tld="com.ar").write_to_fp(buf)
    buf.seek(0)
    return buf.read()


async def texto_a_audio_base64(texto: str, voz_premium: bool = False) -> str:
    if not texto or not texto.strip():
        return ""

    # Voz premium (ElevenLabs) — solo se usa cuando se pide explícitamente
    # (meditaciones). Si no hay clave o falla, sigue de largo a Edge-TTS.
    if voz_premium:
        async with _ELEVENLABS_SEMAFORO:
            datos = await asyncio.to_thread(_generar_audio_elevenlabs, texto)
        if datos:
            return base64.b64encode(datos).decode("utf-8")
        print("ℹ️ ElevenLabs no disponible, usando Edge-TTS de resguardo.")

    # Intento 1 y 2: edge-tts (voz neuronal argentina)
    for intento in range(2):
        try:
            datos = await _edge_tts(texto)
            return base64.b64encode(datos).decode("utf-8")
        except Exception as e:
            print(f"⚠️ edge-tts fallo (intento {intento + 1}/2): {e}")
            await asyncio.sleep(0.5)

    # Resguardo: gTTS
    try:
        print("ℹ️ Usando gTTS como resguardo.")
        datos = await asyncio.to_thread(_gtts_sync, texto)
        return base64.b64encode(datos).decode("utf-8")
    except Exception as e:
        print(f"⚠️ gTTS también falló: {e}")
        return ""


# -----------------------------------------------------------------
# ENDPOINT: diagnóstico inicial
# -----------------------------------------------------------------
@app.post("/api/diagnostico")
async def diagnostico(
    relato_texto: str = Form(...),
    metricas_faciales: str = Form(default=""),
):
    import json
    metricas = json.loads(metricas_faciales) if metricas_faciales else None

    # Validación: no procesar relatos vacíos o con el fallback genérico
    if not relato_texto or not relato_texto.strip():
        return JSONResponse({"error": "relato_vacio"}, status_code=400)

    resultado = await asyncio.to_thread(generar_diagnostico, relato_texto, metricas)
    audio_b64 = await texto_a_audio_base64(resultado["texto"])

    return JSONResponse({
        "texto": resultado["texto"],
        "energia": resultado["energia"],
        "audio_base64": audio_b64,
    })


# -----------------------------------------------------------------
# ENDPOINT: ejercicio
# -----------------------------------------------------------------
@app.post("/api/ejercicio")
async def ejercicio(
    dominio: str = Form(...),
    herramienta: str = Form(...),
    relato_texto: str = Form(...),
    variante_idx: int = Form(default=0),
):
    resultado = await asyncio.to_thread(
        generar_ejercicio, dominio, herramienta, relato_texto, variante_idx
    )
    pregunta_seguimiento = resultado.get("pregunta_seguimiento", "¿Cómo te quedaste después de esto? ¿Qué notás ahora?")

    # FIX LENTITUD: las 3 voces premium en paralelo se volvían 3 llamadas
    # SECUENCIALES por el semáforo de ElevenLabs (máx. 1 a la vez), y la
    # espera se triplicaba. Ahora solo la consigna (lo primero que se
    # escucha, apenas entra a la pantalla) usa voz premium; el fundamento
    # y la pregunta de seguimiento —que se escuchan recién después, ya
    # dentro del chat— usan la voz rápida de siempre. Se nota mucho menos
    # la espera y sigue sonando "especial" en el momento que más importa.
    audio_consigna, audio_fundamento, audio_pregunta = await asyncio.gather(
        texto_a_audio_base64(resultado["consigna"], voz_premium=True),
        texto_a_audio_base64(resultado["fundamento"]),
        texto_a_audio_base64(pregunta_seguimiento),
    )

    return JSONResponse({
        "consigna": resultado["consigna"],
        "fundamento": resultado["fundamento"],
        "audio_consigna_base64": audio_consigna,
        "audio_fundamento_base64": audio_fundamento,
        "pregunta_seguimiento": pregunta_seguimiento,
        "audio_pregunta_seguimiento_base64": audio_pregunta,
    })


# -----------------------------------------------------------------
# ENDPOINT: bitácora, paso 1 — solo la consigna
# -----------------------------------------------------------------
@app.post("/api/bitacora/consigna")
async def bitacora_consigna(
    dominio: str = Form(...),
    relato_texto: str = Form(...),
    variante_idx: int = Form(default=0),
):
    resultado = await asyncio.to_thread(
        generar_consigna_bitacora, dominio, relato_texto, variante_idx
    )
    audio = await texto_a_audio_base64(resultado["consigna"])
    return JSONResponse({
        "consigna": resultado["consigna"],
        "audio_consigna_base64": audio,
    })


# -----------------------------------------------------------------
# ENDPOINT: bitácora, paso 2 — el "darse cuenta" + la frase poderosa,
# generados recién después de que la persona escribió.
# -----------------------------------------------------------------
@app.post("/api/bitacora/insight")
async def bitacora_insight(
    dominio: str = Form(...),
    consigna: str = Form(...),
    texto_usuario: str = Form(...),
):
    resultado = await asyncio.to_thread(
        generar_insight_bitacora, dominio, consigna, texto_usuario
    )
    audio_insight, audio_frase = await asyncio.gather(
        texto_a_audio_base64(resultado["insight"]),
        texto_a_audio_base64(resultado["frase_poderosa"], voz_premium=True),
    )
    return JSONResponse({
        "insight": resultado["insight"],
        "frase_poderosa": resultado["frase_poderosa"],
        "frase_explicacion": resultado.get("frase_explicacion", ""),
        "audio_insight_base64": audio_insight,
        "audio_frase_base64": audio_frase,
    })


# -----------------------------------------------------------------
# ENDPOINT: transcripción de audio con Gemini
# FIX CLAVE: mime_valido se fuerza a "audio/webm" en vez de leer
# audio.content_type, que en Android Chrome llega como
# "application/octet-stream" y hace que Gemini rechace el archivo
# silenciosamente devolviendo texto vacío.
# FIX CLAVE 2: Part.from_text(text=...) — keyword argument obligatorio
# en google-genai >= 1.0 (bug confirmado en logs de producción).
# -----------------------------------------------------------------
@app.post("/api/transcribir")
async def transcribir(audio: UploadFile = File(...)):
    from motor_ia import client, client_secundario, client_terciario, _generar

    if not client and not client_secundario and not client_terciario:
        return JSONResponse({"texto": "", "error": "sin_cliente"})

    try:
        audio_bytes = await audio.read()

        if len(audio_bytes) < 500:
            print(f"⚠️ Audio demasiado pequeño: {len(audio_bytes)} bytes — descartado.")
            return JSONResponse({"texto": ""})

        # FIX: ignoramos audio.content_type porque Android Chrome envía
        # "application/octet-stream" incluso para audio/webm real.
        # Gemini acepta audio/webm sin importar los codecs internos.
        mime_valido = "audio/webm"

        from google.genai import types as genai_types

        parte_audio = genai_types.Part.from_bytes(
            data=audio_bytes,
            mime_type=mime_valido,
        )
        # FIX: from_text requiere keyword argument text= en google-genai >= 1.0
        parte_texto = genai_types.Part.from_text(
            text=(
                "Transcribí exactamente lo que dice esta persona en español rioplatense. "
                "Devolvé SOLO el texto transcripto, sin comillas, sin explicaciones, "
                "sin puntos al final si no los dijo, sin agregar nada. "
                "Si no hay voz audible o solo hay ruido, devolvé únicamente la palabra: silencio"
            )
        )

        respuesta = _generar(
            [genai_types.Content(role="user", parts=[parte_audio, parte_texto])]
        )

        texto = respuesta.text.strip() if respuesta.text else ""
        if texto.lower().strip(".") == "silencio":
            texto = ""
        print(f"✅ Transcripción: '{texto[:80]}' ({len(audio_bytes)} bytes)")
        return JSONResponse({"texto": texto})

    except Exception as e:
        print(f"⚠️ Error transcribiendo: {type(e).__name__}: {e}")
        return JSONResponse({"texto": "", "error": str(e)})


# -----------------------------------------------------------------
# ENDPOINT: TTS genérico
# -----------------------------------------------------------------
@app.post("/api/tts")
async def tts(texto: str = Form(...)):
    audio_b64 = await texto_a_audio_base64(texto)
    return JSONResponse({"audio_base64": audio_b64})


# -----------------------------------------------------------------
# ENDPOINT: reporte PDF
# -----------------------------------------------------------------
@app.post("/api/reporte")
async def reporte(nombre_usuario: str = Form(...), eventos_json: str = Form(...)):
    import json
    eventos = json.loads(eventos_json)
    pdf_bytes = await asyncio.to_thread(generar_pdf_reporte, nombre_usuario, eventos)
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=Integramente_Reporte_Sesion.pdf"},
    )


# -----------------------------------------------------------------
# ENDPOINT: conversación continua multi-turno
# -----------------------------------------------------------------
@app.post("/api/conversar")
async def conversar(
    mensaje_usuario: str = Form(...),
    dominio: str = Form(...),
    herramienta: str = Form(...),
    relato_original: str = Form(...),
    historial_json: str = Form(default="[]"),
):
    import json
    if not mensaje_usuario or not mensaje_usuario.strip():
        return JSONResponse({"error": "mensaje_vacio"}, status_code=400)

    historial = json.loads(historial_json) if historial_json else []
    resultado = await asyncio.to_thread(
        continuar_conversacion,
        mensaje_usuario, dominio, herramienta, relato_original, historial
    )
    audio_b64 = await texto_a_audio_base64(resultado["texto"])

    return JSONResponse({
        "texto": resultado["texto"],
        "sugiere_cerrar": resultado.get("sugiere_cerrar", False),
        "audio_base64": audio_b64,
    })


# -----------------------------------------------------------------
# ENDPOINT: meditación guiada por pasos
# FIX LAZY (créditos de ElevenLabs): antes se generaban TODOS los audios
# (intro + pregunta de cierre + cada paso) de una sola vez, con
# asyncio.gather, antes de mostrar la primera pantalla. Esto disparaba
# varios pedidos simultáneos a ElevenLabs (gatillando el 429 de "too many
# concurrent requests") y además gastaba créditos de pasos que la persona
# capaz nunca llegaba a escuchar si saltaba la meditación a la mitad.
# Ahora solo se genera acá el audio de la intro (lo único que hace falta
# para arrancar ya mismo); cada paso siguiente se pide bajo demanda al
# endpoint /api/meditacion/audio-paso, uno por vez, mientras la persona
# todavía está viendo el paso anterior — así saltar sí ahorra créditos.
# -----------------------------------------------------------------
@app.post("/api/meditacion")
async def meditacion(
    dominio: str = Form(...),
    herramienta: str = Form(...),
    relato_texto: str = Form(...),
    energia: str = Form(default="baja"),
):
    resultado = await asyncio.to_thread(
        generar_meditacion, dominio, herramienta, relato_texto, energia
    )

    audio_intro = await texto_a_audio_base64(resultado.get("intro", ""), voz_premium=True)

    return JSONResponse({
        "intro": resultado.get("intro", ""),
        "pasos": resultado.get("pasos", []),
        "pregunta_cierre": resultado.get("pregunta_cierre", ""),
        "categoria": resultado.get("categoria", "pausa"),
        "audio_intro_base64": audio_intro,
    })


@app.post("/api/meditacion/audio-paso")
async def meditacion_audio_paso(texto: str = Form(...)):
    """Genera el audio premium de UN paso puntual de la meditación, bajo
    demanda. Parte del fix lazy de arriba: si la persona saltea la
    meditación antes de llegar a este paso, este endpoint nunca se llama
    y ese audio nunca se genera — ahí es donde se ahorran los créditos."""
    audio_b64 = await texto_a_audio_base64(texto, voz_premium=True)
    return JSONResponse({"audio_base64": audio_b64})


# -----------------------------------------------------------------
# ENDPOINT: verificación de clave de administrador
# Candado liviano para la pantalla de estadísticas de "Tu opinión" (no es
# un sistema de usuarios real). La clave se define en Render como
# ADMIN_CLAVE — nunca queda escrita en el código ni viaja al frontend.
# -----------------------------------------------------------------
ADMIN_CLAVE = os.environ.get("ADMIN_CLAVE")


@app.post("/api/admin/verificar")
async def admin_verificar(clave: str = Form(...)):
    if not ADMIN_CLAVE:
        return JSONResponse({"ok": False})
    return JSONResponse({"ok": clave == ADMIN_CLAVE})


# -----------------------------------------------------------------
# Health check
# -----------------------------------------------------------------
@app.get("/api/salud")
async def salud():
    return {"estado": "ok", "servicio": "ÍntegraMENTE API"}


# -----------------------------------------------------------------
# Frontend estático — path ABSOLUTO para evitar fallos por CWD en Render.
# __file__ es app/backend/main.py → parent.parent = app/ → + frontend
# -----------------------------------------------------------------
_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(_FRONTEND_DIR), html=True), name="frontend")
