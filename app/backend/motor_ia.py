# =================================================================
# MOTOR DE IA - ÍNTEGRAMENTE
# Versión definitiva — auditada línea por línea.
# Fixes aplicados vs. versión anterior:
#   · dict | None → Optional[dict] (compatible con Python 3.9)
#   · Prompt de diagnóstico: cruce multimodal OBLIGATORIO entre
#     lenguaje del relato y métricas faciales de MediaPipe
#   · generate_content() movido a asyncio.to_thread() en main.py
#     para no bloquear el event loop de FastAPI (llamada síncrona)
# =================================================================

import os
import json
import asyncio
from typing import Optional
from google import genai
from base_conocimiento import contexto_para_dominio

# -----------------------------------------------------------------
# CLASIFICADOR DE ESTADO DE ÁNIMO — 5 categorías, usadas para elegir
# el estilo de meditación y para el gráfico de "energía por fecha"
# del dashboard de métricas.
# -----------------------------------------------------------------
CATEGORIAS_ANIMO = ["estres", "autocompasion", "enfoque", "alegria", "pausa"]

_PALABRAS_CATEGORIA = {
    "estres": ["estres", "estrés", "ansiedad", "ansios", "nervios", "agobiad",
               "presion", "presión", "tenso", "tensa", "acelerad", "urgencia"],
    "autocompasion": ["no sirvo", "no puedo con", "fracas", "culpa", "me equivoqu",
                       "no soy suficiente", "insegur", "menos que", "no valgo"],
    "enfoque": ["no puedo parar de pensar", "mente dispersa", "no me puedo concentrar",
                "le doy vueltas", "distraíd", "distraid", "disperso", "dispersa", "no me concentro"],
    "alegria": ["feliz", "content", "alegr", "agradecid", "entusiasmad", "orgullos", "buena onda"],
    "pausa": ["cansad", "agotad", "sin energia", "sin energía", "exhaust", "quiero descansar", "sin fuerzas"],
}


def clasificar_estado_animo(relato_texto: str, energia: str = "baja") -> str:
    """Heurística simple por palabras clave, con la energía del diagnóstico
    como respaldo si el texto no da señales claras."""
    texto = (relato_texto or "").lower()
    puntajes = {cat: 0 for cat in CATEGORIAS_ANIMO}
    for cat, palabras in _PALABRAS_CATEGORIA.items():
        puntajes[cat] = sum(1 for palabra in palabras if palabra in texto)
    mejor = max(puntajes, key=puntajes.get)
    if puntajes[mejor] == 0:
        return "alegria" if energia == "alta" else "pausa"
    return mejor

# Las claves NUNCA se escriben en el código. Se leen de las variables de
# entorno configuradas en el panel de Render (Environment).
# GEMINI_API_KEY_2 y GEMINI_API_KEY_3 son opcionales: si están cargadas, la
# app pasa a la siguiente sola cuando la anterior se queda sin cuota diaria
# (plan gratis: 20/día por proyecto de Google Cloud).
API_KEY = os.environ.get("GEMINI_API_KEY")
API_KEY_2 = os.environ.get("GEMINI_API_KEY_2")
API_KEY_3 = os.environ.get("GEMINI_API_KEY_3")

if not API_KEY:
    print(
        "⚠️  ADVERTENCIA: GEMINI_API_KEY no encontrada. "
        "El motor usará respuestas de resguardo hasta que se configure."
    )

client = genai.Client(api_key=API_KEY) if API_KEY else None
client_secundario = genai.Client(api_key=API_KEY_2) if API_KEY_2 else None
client_terciario = genai.Client(api_key=API_KEY_3) if API_KEY_3 else None
# Orden de intento: principal → secundaria → terciaria. Se recorre la
# lista completa antes de rendirse, así sumar una clave más no requiere
# tocar la lógica de _generar de nuevo.
_CLIENTES = [c for c in (client, client_secundario, client_terciario) if c]
MODELO = "gemini-flash-latest"  # alias de Google: siempre el Flash más actual disponible


def _generar(contents):
    """Genera contenido probando las claves en orden (principal → 2da →
    3ra). Si una se quedó sin cuota diaria (429 / RESOURCE_EXHAUSTED),
    pasa a la siguiente automáticamente, sin que el usuario note nada.
    `contents` puede ser un prompt de texto o una lista de partes (como
    en la transcripción de audio)."""
    if not _CLIENTES:
        raise RuntimeError("Sin clientes de Gemini disponibles")
    ultimo_error = None
    for i, cliente_actual in enumerate(_CLIENTES):
        try:
            return cliente_actual.models.generate_content(model=MODELO, contents=contents)
        except Exception as e:
            ultimo_error = e
            es_cuota = "RESOURCE_EXHAUSTED" in str(e) or "429" in str(e)
            hay_siguiente = i + 1 < len(_CLIENTES)
            if not (es_cuota and hay_siguiente):
                raise
            print(f"⚠️ Clave de Gemini #{i + 1} sin cuota — paso a la clave #{i + 2}.")
    raise ultimo_error

# -----------------------------------------------------------------
# SYSTEM PROMPT — tono de marca fijo en cada llamada.
# Controla: voseo rioplatense, sin "usted", sin muletillas porteñas,
# sin términos clínicos, análisis ontológico del relato,
# cruce multimodal obligatorio (lenguaje + gestos faciales),
# y reglas anti-alucinación.
# -----------------------------------------------------------------
SYSTEM_PROMPT = """Sos el acompañante de ÍntegraMENTE, un espacio de bienestar
emocional para personas mayores de 18 años. Tu función es ayudar a la persona a
ver una posibilidad donde antes solo veía un problema, y acompañarla a moverse
desde donde está hacia donde quiere estar.

No sos terapeuta ni psicólogo. No hacés diagnósticos. Acompañás un momento del día.

══════════════════════════════════════════════
REGLAS DE TONO — OBLIGATORIAS EN TODA RESPUESTA
══════════════════════════════════════════════
- Hablá SIEMPRE de "vos" (voseo rioplatense neutro): "vos sentís", "notás", "te invito a".
- PROHIBIDO usar "usted" en cualquier contexto.
- PROHIBIDO usar muletillas porteñas marcadas: "che", "posta", "obvio", "boludo", "dale".
- Registro: cálido, directo, humano. Como alguien que sabe escuchar y abre preguntas.
- PROHIBIDO usar términos de diagnóstico clínico: "ansiedad", "depresión", "tristeza
  patológica", "trastorno", "síntoma". Usá lenguaje de energía y momento presente:
  "energía baja", "un momento de pausa", "tu día de hoy", "lo que estás atravesando".
- PROHIBIDO NOMBRAR, aunque sea de pasada, cualquier corriente teórica, escuela de
  pensamiento o autor: no digas "coaching ontológico", "psicología positiva",
  "Echeverría", "Seligman", ni ningún término académico o cita atribuida. Nunca
  encuadres una idea como "la psicología dice que..." o "desde el coaching se
  entiende que...". Dale a la persona la herramienta o la mirada concreta,
  como algo propio de la conversación — nunca menciones de dónde viene.
- Si el relato sugiere riesgo para la persona o terceros: respondé con calidez, no
  minimices, y sugerí buscar ayuda profesional humana de forma directa y clara.

══════════════════════════════════════════════
ANÁLISIS ONTOLÓGICO DEL RELATO — OBLIGATORIO
══════════════════════════════════════════════
Antes de redactar tu respuesta, analizá internamente:
1. LENGUAJE: ¿predomina lenguaje de POSIBILIDAD ("puedo", "elijo", "quiero", "voy a")
   o de LIMITACIÓN/JUICIO ("no puedo", "siempre me pasa", "nunca", "tengo que")?
2. POSTURA EMOCIONAL: ¿habla desde la queja, la resignación o la apertura a la acción?
3. Tu devolución DEBE reflejar este análisis: si detectás limitación, abrí suavemente
   una distinción hacia la posibilidad. Si hay posibilidad, reforzala como fortaleza.

══════════════════════════════════════════════
REGLA DURA — NUNCA VALIDAR UNA CREENCIA LIMITANTE (no negociable)
══════════════════════════════════════════════
- Nunca valides una creencia limitante como verdad definitiva o permanente,
  por más negativo o desesperanzado que sea el relato.
- PROHIBIDO cerrar una respuesta con frases que confirmen la limitación como
  algo fijo ("está bien que sigas así", "es entendible que no puedas", "tiene
  sentido que te quedes ahí" sin ninguna apertura). Siempre, sin excepción,
  la respuesta tiene que dejar una puerta abierta hacia la posibilidad —
  aunque sea chica, aunque sea una sola pregunta que abra una grieta.
- Esto es distinto de una situación de riesgo real (autolesión, daño a
  terceros): ahí aplica la regla de arriba sobre sugerir ayuda profesional.
  Esta regla es para el día a día de alguien angustiado, no para emergencias.

══════════════════════════════════════════════
REGLA DURA — NUNCA SONAR FORMULAICO (no negociable)
══════════════════════════════════════════════
- Cada respuesta tiene que citar o parafrasear muy de cerca algo TEXTUAL que
  la persona dijo o escribió en este intercambio puntual — no una paráfrasis
  genérica que serviría para cualquier conversación.
- PROHIBIDO repetir la misma estructura de apertura de oración de una
  respuesta a otra (por ejemplo, no empieces siempre con "Noto que..." o
  "Siento que tu..."). Variá la forma en cada respuesta, aunque el contenido
  de fondo sea similar.

══════════════════════════════════════════════
ANÁLISIS MULTIMODAL — OBLIGATORIO, PERO SIEMPRE INTERNO
══════════════════════════════════════════════
Tu análisis se arma con tres fuentes: LO QUE LA PERSONA DICE (fuente principal,
tomala al 100%), su ROSTRO y su POSTURA CORPORAL (señales que suman matiz).
- Nunca reemplaces ni contradigas lo que la persona cuenta con sus palabras
  por lo que muestran el rostro o el cuerpo — esas son señales adicionales,
  no la verdad por encima del relato.
- Cuando recibís señales de rostro y/o cuerpo junto con el relato, DEBÉS
  usarlas para calibrar el TONO y la profundidad de tu respuesta (más suave,
  más pausada, más directa a una posibilidad de acción) — nunca para
  describirlas. Ejemplo: si el relato dice "estoy bien" pero el rostro
  muestra tensión y el cuerpo está encorvado, respondé con más calidez y
  una pregunta más abierta, sin mencionar la tensión ni la postura.
- PROHIBIDO nombrar o describir lo que ves en el rostro o el cuerpo de la
  persona, de cualquier forma, aunque sea en lenguaje cotidiano ("tu ceño",
  "tu mirada", "tus hombros", "tu postura"). Esto predispone a que la persona
  se pregunte "¿qué está mirando?" en vez de sentirse escuchada. Las señales
  de rostro y cuerpo son un insumo 100% interno para vos, nunca un dato que
  se comparte con la persona.
- NO menciones nombres técnicos de métricas ni de modelos (no digas
  "browDownLeft", "MediaPipe", "landmarks", etc.) — esto ya estaba prohibido,
  y ahora también está prohibido su equivalente en lenguaje llano.
- Si no hay señales de rostro o cuerpo disponibles (canal texto o audio),
  trabajá solo con el relato. Nunca inventes señales que no recibiste.


══════════════════════════════════════════════
REGLAS ANTI-ALUCINACIÓN — OBLIGATORIAS
══════════════════════════════════════════════
- El fundamento teórico que recibís como contexto viene de coaching ontológico
  y psicología positiva, pero tu respuesta NUNCA debe nombrar esas corrientes
  ni a sus autores. Traducí siempre el principio a una herramienta concreta o
  una mirada, en lenguaje cotidiano, como si fuera tuya.
- NO inventes citas textuales. Parafraseá el principio sin comillas de cita.
- NO inventes nombres de técnicas que no estén en el contexto teórico recibido.
- NO inventes estadísticas ni porcentajes de efectividad.
- Toda respuesta debe poder trazarse a al menos un principio del contexto teórico.
- Las consignas deben estar conectadas al relato concreto de esta persona,
  nunca ser genéricas e intercambiables entre distintos usuarios.
"""

SEÑALES_DE_RIESGO = [
    "según un estudio", "estudios demuestran", "investigadores de la universidad",
    "% de las personas", "comprobado científicamente",
]


def _sospechosa(texto: str) -> bool:
    t = texto.lower()
    return any(s in t for s in SEÑALES_DE_RIESGO)


def _resguardo(tipo: str) -> str:
    resguardos = {
        "diagnostico_alto": (
            "Validamos tu energía de hoy y celebramos este espacio de vitalidad "
            "que traés a la sesión. Para sintonizar con tu momento, ¿desde qué "
            "dimensión elegís que te acompañemos?"
        ),
        "diagnostico_bajo": (
            "Notamos que tu energía hoy te está invitando a una pausa consciente. "
            "Para abrazar este momento, ¿desde qué dimensión elegís que te acompañemos?"
        ),
        "ejercicio": (
            "Te invitamos a habitar este ejercicio con presencia. "
            "Cuando estés lista o listo, contanos cómo te sentís."
        ),
        "devolucion": (
            "Validamos tu emoción actual y celebramos este espacio de estructura "
            "y transformación."
        ),
    }
    return resguardos.get(tipo, "Validamos tu emoción actual y este espacio de vitalidad.")


def generar_diagnostico(
    relato_texto: str,
    metricas_faciales: Optional[dict] = None,
) -> dict:
    """Genera el diagnóstico empático inicial.
    Cruza el relato textual con las métricas faciales Y de postura corporal
    de MediaPipe cuando están disponibles (canal video). El relato verbal es
    SIEMPRE la fuente principal — el cuerpo y el rostro son señales que
    corroboran o contrastan lo que la persona dice, nunca lo reemplazan.
    Devuelve {"texto": str, "energia": "alta" | "baja"}.
    """

    # Acepta tanto el formato viejo (dict plano de blendshapes) como el nuevo
    # multimodal {"facial": {...}, "postura": {...}}, para no romper nada.
    metricas_facial_dict = metricas_faciales or {}
    metricas_postura_dict = {}
    if metricas_faciales and ("facial" in metricas_faciales or "postura" in metricas_faciales):
        metricas_facial_dict = metricas_faciales.get("facial") or {}
        metricas_postura_dict = metricas_faciales.get("postura") or {}

    contexto_facial = ""
    if metricas_facial_dict:
        ceja = max(
            metricas_facial_dict.get("browDownLeft", 0),
            metricas_facial_dict.get("browDownRight", 0),
        )
        sonrisa = max(
            metricas_facial_dict.get("mouthSmileLeft", 0),
            metricas_facial_dict.get("mouthSmileRight", 0),
        )
        frown = max(
            metricas_facial_dict.get("mouthFrownLeft", 0),
            metricas_facial_dict.get("mouthFrownRight", 0),
        )
        squint = max(
            metricas_facial_dict.get("eyeSquintLeft", 0),
            metricas_facial_dict.get("eyeSquintRight", 0),
        )

        señales = []
        if ceja > 0.3:
            señales.append(f"ceño fruncido (intensidad {ceja:.2f}/1.0)")
        if frown > 0.3:
            señales.append(f"comisuras de la boca hacia abajo (intensidad {frown:.2f}/1.0)")
        if sonrisa > 0.3:
            señales.append(f"sonrisa presente (intensidad {sonrisa:.2f}/1.0)")
        if squint > 0.3:
            señales.append(f"ojos entrecerrados (intensidad {squint:.2f}/1.0)")

        if señales:
            contexto_facial = "\nROSTRO — " + "; ".join(señales) + "."
        else:
            contexto_facial = "\nROSTRO — expresión neutra, sin señales marcadas."

    contexto_postura = ""
    if metricas_postura_dict:
        señales_postura = []
        if metricas_postura_dict.get("cabezaCaida", 0) > 0.55:
            señales_postura.append("cabeza caída / mirando hacia abajo")
        if metricas_postura_dict.get("hombrosAsimetricos", 0) > 0.3:
            señales_postura.append("hombros tensos o desnivelados")
        if metricas_postura_dict.get("torsoInclinado", 0) > 0.3:
            señales_postura.append("torso inclinado hacia un costado")
        if metricas_postura_dict.get("aperturaCorporal", 0.5) < 0.3:
            señales_postura.append("postura cerrada, brazos cerca del cuerpo")
        elif metricas_postura_dict.get("aperturaCorporal", 0.5) > 0.7:
            señales_postura.append("postura abierta")

        if señales_postura:
            contexto_postura = "\nCUERPO — " + "; ".join(señales_postura) + "."
        else:
            contexto_postura = "\nCUERPO — postura relajada, sin señales marcadas de tensión."

    hay_multimodal = bool(contexto_facial or contexto_postura)

    prompt = f"""{SYSTEM_PROMPT}

Una persona usuaria de ÍntegraMENTE compartió lo siguiente sobre su momento actual.
Esto es la fuente PRINCIPAL: tomá cien por ciento lo que dice, en sus propias
palabras y su propio tono, como base de tu análisis. Rostro y cuerpo son señales
adicionales que suman matiz — nunca reemplazan ni contradicen lo que la persona
cuenta con sus palabras.

RELATO DE LA PERSONA (fuente principal):
"{relato_texto}"
{contexto_facial}{contexto_postura}

Generá una devolución empática de diagnóstico inicial (3 a 4 oraciones) que:
1. Parta 100% de lo que la persona dijo — nombrá algo concreto y específico de
   su relato, no una validación genérica que serviría para cualquiera.
2. {"Cruce las tres fuentes: si el rostro y/o el cuerpo confirman o contrastan con lo que dice, nombralo con calidez y en lenguaje humano (nunca menciones nombres técnicos de métricas)." if hay_multimodal else "Reconozca el tono del relato (posibilidad o limitación) y lo que eso dice de este momento."}
3. Reconozca si la energía está alta/dinámica o si el cuerpo está pidiendo pausa.
4. Termine con una frase puente que invite a elegir un dominio para seguir
   trabajando (Cuerpo, Lenguaje o Emoción) — algo como "Para ver de qué forma
   podemos trabajar esto, ¿desde dónde te gustaría empezar?", conectado a lo
   que la persona ya contó, nunca genérico.

Respondé en formato JSON estricto, sin texto fuera del JSON:
{{"texto": "...", "energia": "alta" o "baja"}}
"""

    if not client and not client_secundario and not client_terciario:
        es_alta = any(p in relato_texto.lower() for p in ["bien", "content", "mejor", "feliz"])
        return {
            "texto": _resguardo("diagnostico_alto" if es_alta else "diagnostico_bajo"),
            "energia": "alta" if es_alta else "baja",
        }

    for intento in range(2):
        try:
            response = _generar(prompt)
            bruto = response.text.strip().replace("```json", "").replace("```", "").strip()
            data = json.loads(bruto)
            if "texto" not in data or "energia" not in data:
                raise ValueError("JSON incompleto")
            if _sospechosa(data["texto"]):
                print(f"⚠️ Alucinación detectada en intento {intento + 1}, reintentando...")
                continue
            return data
        except Exception as e:
            print(f"⚠️ Error diagnóstico (intento {intento + 1}): {e}")

    return {"texto": _resguardo("diagnostico_bajo"), "energia": "baja"}


# -----------------------------------------------------------------
# EXPLICACIÓN PROFUNDA — se usa DESPUÉS del intercambio corto inicial,
# antes de que la persona elija un dominio. Cruza el relato original +
# lo que agregó en la charla + las señales multimodales.
# -----------------------------------------------------------------
def generar_explicacion_profunda(
    relato_original: str,
    historial_chat: list,
    metricas_faciales: Optional[dict] = None,
) -> dict:
    hist_txt = "\n".join(
        f"{'Persona' if t['rol']=='usuario' else 'ÍntegraMENTE'}: {t['texto']}"
        for t in historial_chat[-6:]
    )

    prompt = f"""{SYSTEM_PROMPT}

RELATO ORIGINAL:
"{relato_original}"

CONVERSACIÓN QUE SIGUIÓ:
{hist_txt}

Ya escuchaste a esta persona en su relato inicial y en lo que agregó después.
Ahora ofrecele una mirada más profunda (3-4 oraciones) de lo que puede estar
pasando — el "por qué" detrás de lo que compartió. Conectá el relato original
con lo que agregó en la charla, no los trates como cosas separadas. Cerrá
invitando a elegir un dominio para seguir trabajando: Cuerpo, Lenguaje o Emoción.

Respondé en formato JSON estricto:
{{"texto": "..."}}
"""

    if not client and not client_secundario and not client_terciario:
        return {"texto": _resguardo("devolucion")}

    for intento in range(2):
        try:
            response = _generar(prompt)
            bruto = response.text.strip().replace("```json", "").replace("```", "").strip()
            data = json.loads(bruto)
            if "texto" not in data:
                raise ValueError("JSON incompleto")
            return data
        except Exception as e:
            print(f"⚠️ Error explicación profunda (intento {intento + 1}): {e}")

    return {"texto": _resguardo("devolucion")}


def generar_ejercicio(
    dominio: str,
    herramienta: str,
    relato_texto: str,
    variante_idx: int,
) -> dict:
    """Genera el ejercicio y su devolución/fundamento.
    Anclado en la base de conocimiento curada del dominio elegido
    y en el relato original de la persona.
    """
    contexto_teorico = contexto_para_dominio(dominio, herramienta)

    prompt = f"""{SYSTEM_PROMPT}

{contexto_teorico}

La persona eligió trabajar el dominio "{dominio}" con la herramienta "{herramienta}".
Su relato original fue: "{relato_texto}"
Esta es la variante número {variante_idx + 1} que recibe en esta combinación durante la sesión.

IMPORTANTE: ya recibió {variante_idx} ejercicio(s) anterior(es) en esta combinación.
Es OBLIGATORIO generar una consigna genuinamente diferente: cambiá el enfoque, la
pregunta, la acción concreta o el ángulo del marco teórico. Nunca repitas estructura.

Generá:
1. Consigna de ejecución breve y clara (2-3 oraciones), con fundamento en el marco
   teórico y conectada al relato concreto de la persona.
2. Devolución/fundamento (2-3 oraciones) que explique el "para qué" del ejercicio,
   anclada en el marco teórico.
3. Una pregunta de seguimiento CONCRETA para arrancar la charla después del
   ejercicio — tiene que hacer referencia directa a lo que la consigna pidió
   hacer. Por ejemplo, si la consigna pidió pensar una frase, la pregunta de
   seguimiento tiene que ser del estilo "¿la querés compartir?" — nunca algo
   genérico como "¿cómo te sentís?".

Respondé en formato JSON estricto, sin texto fuera del JSON:
{{"consigna": "...", "fundamento": "...", "pregunta_seguimiento": "..."}}
"""

    PREGUNTA_SEGUIMIENTO_RESGUARDO = "¿Cómo te quedaste después de esto? ¿Qué notás ahora?"

    if not client and not client_secundario and not client_terciario:
        return {
            "consigna": _resguardo("ejercicio"),
            "fundamento": _resguardo("devolucion"),
            "pregunta_seguimiento": PREGUNTA_SEGUIMIENTO_RESGUARDO,
        }

    for intento in range(2):
        try:
            response = _generar(prompt)
            bruto = response.text.strip().replace("```json", "").replace("```", "").strip()
            data = json.loads(bruto)
            if "consigna" not in data or "fundamento" not in data:
                raise ValueError("JSON incompleto")
            if _sospechosa(data["consigna"]) or _sospechosa(data["fundamento"]):
                print(f"⚠️ Alucinación detectada en intento {intento + 1}, reintentando...")
                continue
            data.setdefault("pregunta_seguimiento", PREGUNTA_SEGUIMIENTO_RESGUARDO)
            return data
        except Exception as e:
            print(f"⚠️ Error ejercicio (intento {intento + 1}): {e}")

    resultado = {
        "consigna": _resguardo("ejercicio"),
        "fundamento": _resguardo("devolucion"),
        "pregunta_seguimiento": PREGUNTA_SEGUIMIENTO_RESGUARDO,
    }
    return resultado


# -----------------------------------------------------------------
# CONVERSACIÓN MULTI-TURNO — post ejercicio / post meditación
# La IA responde, valida y abre posibilidad turno a turno.
# -----------------------------------------------------------------
def continuar_conversacion(
    mensaje_usuario: str,
    dominio: str,
    herramienta: str,
    relato_original: str,
    historial: list,
) -> dict:
    """
    Genera la respuesta de la IA en la conversación continua.
    historial: lista de dicts [{rol: "usuario"|"ia", texto: "..."}]
    Devuelve {"texto": str, "sugiere_cerrar": bool}
    """
    hist_txt = ""
    for turno in historial[-6:]:  # últimos 6 turnos
        rol = "Persona" if turno["rol"] == "usuario" else "ÍntegraMENTE"
        hist_txt += f"{rol}: {turno['texto']}\n"

    contexto_dominio = (
        f"- Dominio elegido: {dominio}\n- Herramienta usada: {herramienta}\n"
        if dominio else
        "- Todavía no eligió un dominio para trabajar — está en la charla inicial,\n"
        "  contando un poco más antes de elegir. No le preguntes por un dominio,\n"
        "  eso se lo va a ofrecer la pantalla siguiente.\n"
    )

    prompt = f"""{SYSTEM_PROMPT}

CONTEXTO DE LA SESIÓN:
- Relato original: "{relato_original}"
{contexto_dominio}
CONVERSACIÓN HASTA AHORA:
{hist_txt if hist_txt else "(primera respuesta post-ejercicio)"}

La persona acaba de decir:
"{mensaje_usuario}"

Respondé en forma natural, breve y cálida (máximo 4 oraciones):
1. Validá lo que dijo sin juzgarlo, nombrando algo concreto de lo que dijo (nunca una frase genérica).
2. Si ya llevás 2 o más turnos de conversación, no te quedes solo en preguntas: ofrecé UNA acción chica y concreta
   para probar, conectada a lo que la persona viene contando — algo que pueda hacer hoy o la próxima vez que
   sienta lo mismo. Formulala como invitación, nunca como orden ("te propongo probar con...", no "deberías...").
   Ejemplo de la diferencia: en vez de solo preguntar "¿qué podrías hacer diferente?", proponé algo puntual y
   preguntá si le sirve probarlo.
3. Si es el primer o segundo turno y todavía no hay suficiente contexto para una propuesta concreta, seguí
   profundizando con una pregunta abierta que ayude a entender mejor la situación.
4. Si la persona parece llegar a un cierre natural (dice que está mejor, que quiere terminar,
   que ya tiene claridad), marcalo y ofrecé cerrar la sesión.

ADEMÁS, decidí si corresponde sugerir una de las 3 herramientas disponibles en este dominio:
- "practica_guiada" (Ejercicio del momento): algo breve para hacer ahora mismo.
- "microaudio" (Meditación guiada): una voz que acompaña de principio a fin.
- "bitacora" (Tu bitácora): escribir y soltar.
Sugerí una SOLO si (a) la persona la pidió explícitamente ("dame algo para hacer", "necesito una
herramienta"), o (b) la charla ya dio suficientes vueltas sobre lo mismo y vos, como acompañante,
sentís que es un buen momento para proponer algo concreto de hacer. Si ninguna de las dos aplica,
dejá ese campo en null — no sugieras en cada turno, solo cuando realmente suma.

Respondé en JSON estricto:
{{"texto": "...", "sugiere_cerrar": true o false, "sugiere_herramienta": "practica_guiada" o "microaudio" o "bitacora" o null}}
"""

    if not client and not client_secundario and not client_terciario:
        return {"texto": _resguardo("devolucion"), "sugiere_cerrar": False, "sugiere_herramienta": None}

    for intento in range(2):
        try:
            response = _generar(prompt)
            bruto = response.text.strip().replace("```json", "").replace("```", "").strip()
            data = json.loads(bruto)
            if "texto" not in data:
                raise ValueError("JSON incompleto")
            data.setdefault("sugiere_herramienta", None)
            return data
        except Exception as e:
            print(f"⚠️ Error conversación (intento {intento + 1}): {e}")

    return {"texto": _resguardo("devolucion"), "sugiere_cerrar": False, "sugiere_herramienta": None}


# -----------------------------------------------------------------
# MEDITACIÓN GUIADA POR PASOS — con pausas automáticas entre instrucciones
# -----------------------------------------------------------------
def generar_meditacion(
    dominio: str,
    herramienta: str,
    relato_texto: str,
    energia: str = "baja",
) -> dict:
    """
    Genera una meditación personalizada como lista de pasos.
    Cada paso es una instrucción breve con su duración de pausa en segundos.
    El estilo varía según el dominio elegido:
      - Cuerpo: escaneo corporal / respiración
      - Lenguaje: mantras / frases para repetir
      - Emoción: reconexión clásica con el presente
    Devuelve {"intro": str, "pasos": [...], "pregunta_cierre": str, "categoria": str}
    """
    contexto = contexto_para_dominio(dominio, "microaudio")
    categoria = clasificar_estado_animo(relato_texto, energia)

    ESTILO_POR_DOMINIO = {
        "Cuerpo": (
            "Estilo: ESCANEO CORPORAL Y RESPIRACIÓN. Los pasos guían la atención por "
            "distintas partes del cuerpo (pies, manos, hombros, respiración) y usan "
            "instrucciones de respiración medida."
        ),
        "Lenguaje": (
            "Estilo: MANTRA. Los primeros pasos son de acomodo breve, y el cuerpo central "
            "de la meditación repite una frase corta (mantra) 3 o 4 veces, dejando pausas "
            "largas entre repetición y repetición para que la persona la haga propia."
        ),
        "Emocion": (
            "Estilo: RECONEXIÓN CON EL PRESENTE. Los pasos ayudan a notar y nombrar lo que "
            "se siente ahora, sin analizarlo, solo habitándolo con calidez."
        ),
    }
    estilo = ESTILO_POR_DOMINIO.get(dominio, ESTILO_POR_DOMINIO["Emocion"])

    prompt = f"""{SYSTEM_PROMPT}

{contexto}

La persona eligió "{herramienta}" en el dominio "{dominio}".
Su relato: "{relato_texto}"
Estado de ánimo detectado para esta sesión: {categoria}.

{estilo}

Generá una meditación guiada personalizada. Cada paso es una instrucción
breve que se lee en voz alta. Entre paso y paso hay una pausa para que
la persona pueda hacer lo que se le pide SIN tener que mirar la pantalla
ni tocar ningún botón.

Reglas:
- Entre 8 y 12 pasos
- Cada instrucción: máximo 20 palabras, que se pueda decir en voz alta
- pausa_seg: cuántos segundos esperar después de leer ese paso
  · Instrucción de acción rápida (cerrar ojos, poner mano): 3 segundos
  · Respiración (inhalá, exhalá): 6 segundos
  · Sostener o sentir algo / repetir un mantra: 8 segundos
  · Silencio o presencia: 10 segundos
- La meditación tiene que estar conectada al relato concreto de la persona
- Terminar con una pregunta de cierre que abra la conversación

Respondé en JSON estricto:
{{
  "intro": "Una oración de introducción cálida",
  "pasos": [
    {{"texto": "Instrucción...", "pausa_seg": 6}},
    ...
  ],
  "pregunta_cierre": "¿Cómo te quedaste con esto?"
}}
"""

    resguardo_pasos = {
        "intro": "Te invito a hacer una pausa. Este momento es tuyo.",
        "pasos": [
            {"texto": "Buscá una posición cómoda.", "pausa_seg": 3},
            {"texto": "Cerrá los ojos si te resulta cómodo.", "pausa_seg": 3},
            {"texto": "Inhalá lento, contando cuatro tiempos.", "pausa_seg": 6},
            {"texto": "Sostené el aire dos tiempos.", "pausa_seg": 3},
            {"texto": "Exhalá lento en cuatro tiempos.", "pausa_seg": 6},
            {"texto": "Repetí esta respiración dos veces más a tu ritmo.", "pausa_seg": 14},
            {"texto": "Llevá la atención a los pies. Sentí el contacto con el piso.", "pausa_seg": 8},
            {"texto": "Soltá cualquier tensión que notes en el cuerpo.", "pausa_seg": 8},
            {"texto": "Respirá una vez más profundo y abrí los ojos despacio.", "pausa_seg": 6},
        ],
        "pregunta_cierre": "¿Cómo te quedaste? ¿Qué notás ahora?",
    }
    resguardo_pasos["categoria"] = categoria

    if not client and not client_secundario and not client_terciario:
        return resguardo_pasos

    for intento in range(2):
        try:
            response = _generar(prompt)
            bruto = response.text.strip().replace("```json", "").replace("```", "").strip()
            data = json.loads(bruto)
            if "pasos" not in data or not isinstance(data["pasos"], list):
                raise ValueError("JSON incompleto")
            data["categoria"] = categoria
            return data
        except Exception as e:
            print(f"⚠️ Error meditación (intento {intento + 1}): {e}")

    return resguardo_pasos


# -----------------------------------------------------------------
# BITÁCORA EN DOS PASOS
# Paso 1: solo la consigna (pregunta reflexiva concreta, para escribir).
# Paso 2 (recién después de que la persona escribe): el "darse cuenta"
# + la frase poderosa, generados en base a lo que realmente escribió.
# -----------------------------------------------------------------
def generar_consigna_bitacora(dominio: str, relato_texto: str, variante_idx: int) -> dict:
    contexto_teorico = contexto_para_dominio(dominio, "bitacora")

    prompt = f"""{SYSTEM_PROMPT}

{contexto_teorico}

La persona eligió trabajar el dominio "{dominio}" con la herramienta "Bitácora".
Su relato original fue: "{relato_texto}"
Esta es la variante número {variante_idx + 1} que recibe en esta combinación durante la sesión.

Generá UNA consigna de escritura — una pregunta reflexiva concreta y explícita,
nunca vaga ni abierta de más. Tiene que decirle exactamente qué escribir, conectada
al relato concreto de la persona. Ejemplo del nivel de concreción esperado:
"Escribí: ¿qué es lo que más te pesa de no tener una rutina fija?" — no algo como
"Escribí sobre tu día".

Respondé en JSON estricto:
{{"consigna": "..."}}
"""

    resguardo = {"consigna": "Escribí libremente lo que estás sintiendo hoy, sin filtro."}
    if not client and not client_secundario and not client_terciario:
        return resguardo

    for intento in range(2):
        try:
            response = _generar(prompt)
            bruto = response.text.strip().replace("```json", "").replace("```", "").strip()
            data = json.loads(bruto)
            if "consigna" not in data:
                raise ValueError("JSON incompleto")
            return data
        except Exception as e:
            print(f"⚠️ Error consigna bitácora (intento {intento + 1}): {e}")

    return resguardo


def generar_insight_bitacora(dominio: str, consigna: str, texto_usuario: str) -> dict:
    """
    Genera el "darse cuenta" (insight) y la frase poderosa, basados en lo
    que la persona realmente escribió — no en el relato original.
    Devuelve {"insight": str, "frase_poderosa": str, "frase_explicacion": str}.
    """
    contexto_teorico = contexto_para_dominio(dominio, "bitacora")

    prompt = f"""{SYSTEM_PROMPT}

{contexto_teorico}

La consigna de escritura fue: "{consigna}"
La persona escribió esto: "{texto_usuario}"

Generá:
1. Un "darse cuenta" (insight, 2-3 oraciones) que refleje directamente lo que la
   persona escribió — citando o parafraseando muy de cerca sus propias palabras,
   nunca genérico. Tiene que sentirse como que de verdad leíste lo que escribió.
2. Una frase poderosa corta (máximo 10 palabras) para que la persona guarde y
   repita cuando lo necesite — en primera persona, tiempo presente, lenguaje de
   posibilidad (nunca de exigencia), nacida específicamente de lo que escribió.
3. Una explicación breve (1-2 oraciones) de cómo esa frase se conecta con lo que
   escribió.

Respondé en JSON estricto:
{{"insight": "...", "frase_poderosa": "...", "frase_explicacion": "..."}}
"""

    resguardo = {
        "insight": "Lo que escribiste tiene el primer paso adentro, aunque todavía no lo veas del todo.",
        "frase_poderosa": "Voy a mi ritmo, y eso también es avanzar.",
        "frase_explicacion": "Repetirla ayuda a bajar la exigencia del momento y a recordar que el proceso también cuenta.",
    }

    if not client and not client_secundario and not client_terciario:
        return resguardo

    for intento in range(2):
        try:
            response = _generar(prompt)
            bruto = response.text.strip().replace("```json", "").replace("```", "").strip()
            data = json.loads(bruto)
            if "insight" not in data or "frase_poderosa" not in data:
                raise ValueError("JSON incompleto")
            return data
        except Exception as e:
            print(f"⚠️ Error insight bitácora (intento {intento + 1}): {e}")

    return resguardo
