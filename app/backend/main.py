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

    # Los 3 audios se generan en paralelo, no en fila — responde más rápido.
    audio_consigna, audio_fundamento, audio_pregunta = await asyncio.gather(
        texto_a_audio_base64(resultado["consigna"]),
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
    from motor_ia import client, client_secundario, _generar

    if not client and not client_secundario:
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
# ENDPOINT: meditación guiada por pasos con audio por paso
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

    # Voz premium (ElevenLabs) para la meditación. Antes se generaba un
    # audio por vez, en fila (intro, paso 1, paso 2...) — ahora se piden
    # todos en paralelo, así responde mucho más rápido.
    pasos = resultado.get("pasos", [])
    audio_intro, audio_pregunta, *audios_pasos = await asyncio.gather(
        texto_a_audio_base64(resultado.get("intro", ""), voz_premium=True),
        texto_a_audio_base64(resultado.get("pregunta_cierre", ""), voz_premium=True),
        *[texto_a_audio_base64(paso["texto"], voz_premium=True) for paso in pasos],
    )

    return JSONResponse({
        "intro": resultado.get("intro", ""),
        "pasos": pasos,
        "pregunta_cierre": resultado.get("pregunta_cierre", ""),
        "categoria": resultado.get("categoria", "pausa"),
        "audio_intro_base64": audio_intro,
        "audios_pasos_base64": audios_pasos,
        "audio_pregunta_base64": audio_pregunta,
    })


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
