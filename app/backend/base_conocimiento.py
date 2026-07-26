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
            "microaudio": [
                {
                    "id": "ESCANEO_CORPORAL",
                    "intro": "te invito a escuchar este escaneo corporal breve para volver "
                              "a habitar tu cuerpo desde los pies hacia arriba",
                    "fundamento": "Recorrer el cuerpo por partes, con atención plena y sin "
                                   "juzgar lo que se encuentra, interrumpe el ciclo de "
                                   "pensamiento anticipatorio y devuelve la atención al único "
                                   "lugar donde el presente realmente ocurre: el cuerpo.",
                },
                {
                    "id": "RESPIRACION_GUIADA_ANCLA",
                    "intro": "te invito a escuchar esta meditación breve de respiración "
                              "guiada para anclarte en el apoyo de tu propio cuerpo",
                    "fundamento": "Anclar la atención en un punto de apoyo físico concreto "
                                   "(los pies en el piso, el peso del cuerpo en la silla) es "
                                   "una técnica de aterrizaje (grounding) que reduce la "
                                   "activación fisiológica sin necesidad de cambiar el pensamiento.",
                },
            ],
            "bitacora": [
                {
                    "id": "BITACORA_SENSACION_FISICA",
                    "intro": "te invito a escribir qué sensación física concreta notás en "
                              "tu cuerpo en este momento, y en qué parte la sentís",
                    "fundamento": "Poner en palabras una sensación física concreta (en vez "
                                   "de una emoción abstracta) es más fácil de sostener y da "
                                   "un punto de partida tangible para observar qué le pasa al "
                                   "cuerpo cuando algo pesa.",
                },
                {
                    "id": "BITACORA_CUERPO_LIBRE",
                    "intro": "te invito a registrar libremente cómo está tu cuerpo hoy, sin "
                              "buscar la palabra correcta, solo describiendo",
                    "fundamento": "Describir el cuerpo sin interpretarlo todavía (antes de "
                                   "nombrar la emoción) genera un registro más honesto, menos "
                                   "filtrado por lo que 'se supone' que uno debería sentir.",
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
            "practica_guiada": [
                {
                    "id": "REFORMULAR_JUICIO",
                    "intro": "te invito a tomar una frase que estés pensando de vos o de tu "
                              "situación y reformularla en el momento hacia el lenguaje de "
                              "posibilidad",
                    "fundamento": "Reformular un juicio de clausura ('no puedo', 'siempre me "
                                   "pasa') en una frase de posibilidad ('todavía no', 'estoy "
                                   "aprendiendo a') no niega lo que se siente, pero le devuelve "
                                   "a la persona el lugar de autor de su propio relato.",
                },
                {
                    "id": "NOMBRAR_EL_JUICIO",
                    "intro": "te invito a decir en voz alta o para vos mismo la frase 'esto "
                              "que pienso es un juicio, no un hecho' sobre lo que te está "
                              "pesando hoy",
                    "fundamento": "Nombrar explícitamente algo como juicio (y no como hecho) "
                                   "es el primer paso del coaching ontológico para poder "
                                   "cuestionarlo y eventualmente rediseñarlo.",
                },
            ],
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
            "microaudio": [
                {
                    "id": "AQUIETAR_RELATO_INTERNO",
                    "intro": "te invito a escuchar esta meditación breve para bajar el "
                              "volumen del relato interpretativo y volver a las palabras "
                              "que realmente dijiste o pensaste, sin el agregado del juicio",
                    "fundamento": "Gran parte del malestar no viene del hecho en sí, sino de "
                                   "la interpretación que se le agrega en el relato interno. "
                                   "Aquietar ese relato, aunque sea por un momento, separa el "
                                   "hecho de la historia que se construyó alrededor.",
                },
                {
                    "id": "LENGUAJE_DE_POSIBILIDAD",
                    "intro": "te invito a escuchar esta reflexión hablada sobre el lenguaje "
                              "que usás para hablarte a vos mismo",
                    "fundamento": "Escuchar (en vez de leer) una reflexión sobre el propio "
                                   "lenguaje interno ayuda a notar, desde un lugar más "
                                   "receptivo, patrones de habla que uno normalmente no nota "
                                   "cuando los piensa en piloto automático.",
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
            "practica_guiada": [
                {
                    "id": "NOMBRAR_LA_EMOCION",
                    "intro": "te invito a ponerle un nombre lo más preciso posible a lo que "
                              "estás sintiendo ahora, en vez de una etiqueta general",
                    "fundamento": "Nombrar con precisión lo que se siente (en vez de "
                                   "'estoy mal') activa un proceso de regulación emocional "
                                   "en sí mismo — ponerle nombre a algo empieza a ordenarlo.",
                },
                {
                    "id": "QUE_HABILITA_LA_EMOCION",
                    "intro": "te invito a pensar qué acción te está habilitando la emoción "
                              "que sentís ahora, y cuál te está cerrando",
                    "fundamento": "Cada emoción abre ciertas posibilidades de acción y cierra "
                                   "otras. Identificar cuáles son, sin juzgar la emoción, "
                                   "devuelve una sensación de agencia sobre el momento.",
                },
            ],
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
            "bitacora": [
                {
                    "id": "BITACORA_QUE_PIDE_LA_EMOCION",
                    "intro": "te invito a escribir qué es lo que esta emoción parece estar "
                              "pidiéndote, sin juzgarla como buena o mala",
                    "fundamento": "Preguntarse qué 'pide' una emoción (en vez de cómo "
                                   "eliminarla) la trata como información válida sobre lo que "
                                   "necesita la persona, no como un error a corregir.",
                },
                {
                    "id": "BITACORA_ACEPTACION_ESCRITA",
                    "intro": "te invito a escribir la frase 'está bien sentir esto ahora' y "
                              "seguir escribiendo lo que aparece después",
                    "fundamento": "Escribir una frase de aceptación activa como punto de "
                                   "partida (y no de resignación) ayuda a soltar la energía "
                                   "que se gasta negando o peleando contra lo que ya se siente.",
                },
            ],
        },
    },
}


def contexto_para_dominio(dominio: str, herramienta: str = None) -> str:
    """Arma el bloque de contexto teórico que se inyecta en el prompt de Gemini
    para que la respuesta tenga fundamento real, citable, del dominio elegido.

    FIX CRÍTICO: antes esta función solo devolvía descripción + principios
    generales del dominio, y el diccionario BASE_CONOCIMIENTO[dominio]["ejercicios"]
    quedaba sin usarse — el contenido curado a mano (los ejemplos concretos con
    fundamento propio) nunca llegaba al prompt real. Ahora, si se pasa
    `herramienta`, se suma el ejemplo curado correspondiente como base concreta
    de la que Gemini parte para generar la variante — en vez de improvisar
    solo con los principios generales del dominio.
    """
    data = BASE_CONOCIMIENTO.get(dominio)
    if not data:
        return ""
    principios = "\n".join(f"- {p}" for p in data["principios"])
    bloque = (
        f"MARCO TEÓRICO DEL DOMINIO '{dominio.upper()}':\n"
        f"{data['descripcion']}\n\n"
        f"Principios a tener en cuenta para fundamentar tu respuesta:\n{principios}\n"
    )

    if herramienta:
        ejemplos = data.get("ejercicios", {}).get(herramienta, [])
        if ejemplos:
            bloque += (
                f"\nEJEMPLOS CURADOS de referencia para la herramienta '{herramienta}' "
                f"en este dominio (usalos como base conceptual y de tono — NO los copies "
                f"literal, generá una variante propia conectada al relato de la persona):\n"
            )
            for ej in ejemplos:
                bloque += (
                    f"- Consigna de referencia: {ej['intro']}\n"
                    f"  Fundamento de referencia: {ej['fundamento']}\n"
                )
    return bloque
