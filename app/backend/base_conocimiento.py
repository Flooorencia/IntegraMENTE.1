# =================================================================
# BASE DE CONOCIMIENTO CURADA - ÍNTEGRAMENTE
# =================================================================
# Esta base reemplaza la "lectura" simulada de 632 PDFs del notebook
# original (que solo contaba archivos sin leer su contenido real).
#
# Es una síntesis curada a mano de principios de coaching ontológico
# y psicología positiva, organizada por dominio. No es un
# RAG vectorial sobre los 632 libros completos (eso requiere
# infraestructura de pago, ver sección 5.3 del Informe Integral).
# Se inyecta como contexto en cada consulta a Gemini para que las
# respuestas tengan fundamento teórico real y citable, en vez de
# ser generadas sin ningún anclaje.
# =================================================================

BASE_CONOCIMIENTO = {
    "Cuerpo": {
        "descripcion": "La corporalidad como dominio del ser. El cuerpo no es un "
                        "objeto que tenemos, es la forma en la que somos en el mundo.",
        "principios": [
            "Coaching ontológico (Echeverría): el cuerpo, el lenguaje y la emoción "
            "son tres dominios coherentes entre sí; un cambio postural genera un "
            "cambio emocional posible, y viceversa.",
            "La respiración consciente activa el sistema nervioso parasimpático, "
            "bajando la frecuencia cardíaca y devolviendo la sensación de control "
            "en momentos de activación alta (enojo, ansiedad, urgencia).",
            "Anclar la atención en una sensación física presente (la postura, "
            "el apoyo de los pies, la respiración) interrumpe el círculo de "
            "pensamientos repetitivos sin necesidad de 'pensar distinto'.",
        ],
        "ejercicios": {
            "practica_guiada": [
                {
                    "id": "RESPIRACION_CUADRADA",
                    "intro": "te invito a realizar este ejercicio interactivo de respiración "
                              "cuadrada para equilibrar tu energía física",
                    "fundamento": "La respiración cuadrada (4 tiempos inhalar, 4 sostener, "
                                   "4 exhalar, 4 sostener) es una técnica usada en control "
                                   "de estrés agudo. Forzar un ritmo medido le devuelve al "
                                   "sistema nervioso una sensación de estructura y previsibilidad.",
                },
                {
                    "id": "ENFOQUE_PANTALLA",
                    "intro": "te invito a realizar una dinámica interactiva de centramiento "
                              "y enfoque visual",
                    "fundamento": "Fijar la mirada en un punto detiene el barrido visual "
                                   "constante asociado a la hipervigilancia ansiosa, y entrena "
                                   "la presencia en el momento actual.",
                },
            ],
        },
    },
    "Lenguaje": {
        "descripcion": "El lenguaje como acción, no solo como descripción. Lo que "
                        "decimos (y cómo lo decimos) construye la realidad en la que vivimos.",
        "principios": [
            "Coaching ontológico: distinguimos entre 'hechos' y 'juicios'. Un juicio "
            "('soy un desastre', 'esto siempre me pasa a mí') se vive como un hecho "
            "pero es una interpretación, y las interpretaciones se pueden rediseñar.",
            "Escribir un juicio (en vez de solo pensarlo) le saca el carácter de "
            "verdad absoluta y permite observarlo como una afirmación más, "
            "cuestionable y rediseñable.",
            "El lenguaje de posibilidad ('todavía no', 'estoy aprendiendo a', "
            "'una parte de mí') abre futuro; el lenguaje de clausura ('nunca', "
            "'siempre', 'no puedo') lo cierra.",
        ],
        "ejercicios": {
            "bitacora": [
                {
                    "id": "BITACORA_JUICIOS",
                    "intro": "te invito a escribir en el casillero una lista de tres juicios "
                              "que estén habitando tu relato de hoy",
                    "fundamento": "Poner los juicios en palabras escritas les quita el peso "
                                   "automático de verdad absoluta y permite observarlos como "
                                   "simples relatos lingüísticos, abriendo la posibilidad de "
                                   "rediseñarlos.",
                },
                {
                    "id": "BITACORA_LIBRE",
                    "intro": "te invito a registrar tu descarga emocional libre escribiendo "
                              "lo que sentís hoy",
                    "fundamento": "La escritura libre, sin estructura ni filtro, permite que "
                                   "el relato interno encuentre una forma externa, generando "
                                   "alivio inmediato y dando material concreto para trabajar después.",
                },
            ],
        },
    },
    "Emocion": {
        "descripcion": "La emoción como predisposición a la acción, no como un "
                        "estado a evitar o reprimir.",
        "principios": [
            "Coaching ontológico: cada emoción habilita ciertas acciones y cierra "
            "otras. No se trata de 'no sentir' sino de observar qué emoción está "
            "presente y qué posibilidades de acción abre o cierra.",
            "Psicología positiva (Seligman): la aceptación activa de una emoción, "
            "sin juzgarla como buena o mala, es distinta a la resignación pasiva. "
            "Aceptar no es rendirse, es dejar de gastar energía negando lo que ya está.",
            "Nombrar con precisión lo que se siente (en vez de etiquetas generales "
            "como 'estoy mal') es, en sí mismo, una herramienta de regulación emocional.",
        ],
        "ejercicios": {
            "microaudio": [
                {
                    "id": "MEDITACION_A_RELATO",
                    "intro": "te invito a escuchar esta meditación de reconexión consciente "
                              "con tu momento presente para frenar el relato interpretativo",
                    "fundamento": "El microaudio de meditación hablada desconecta el ruido "
                                   "interpretativo de fondo. Al escuchar con atención plena, "
                                   "se valida la emoción del presente sin necesidad de "
                                   "analizarla o resolverla de inmediato.",
                },
                {
                    "id": "REFLEXION_B_ACEPTACION",
                    "intro": "te invito a escuchar esta reflexión ontológica hablada para "
                              "habitar la aceptación de tu momento actual",
                    "fundamento": "Habitar la aceptación plena abre posibilidades de diseño. "
                                   "Dejar de exigirse sentir distinto permite moverse de lugar "
                                   "de forma más orgánica que la resistencia activa.",
                },
            ],
        },
    },
}


def contexto_para_dominio(dominio: str) -> str:
    """Arma el bloque de contexto teórico que se inyecta en el prompt de Gemini
    para que la respuesta tenga fundamento real, citable, del dominio elegido."""
    data = BASE_CONOCIMIENTO.get(dominio)
    if not data:
        return ""
    principios = "\n".join(f"- {p}" for p in data["principios"])
    return (
        f"MARCO TEÓRICO DEL DOMINIO '{dominio.upper()}':\n"
        f"{data['descripcion']}\n\n"
        f"Principios a tener en cuenta para fundamentar tu respuesta:\n{principios}\n"
    )
