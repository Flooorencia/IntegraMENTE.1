# =================================================================
# GENERADOR DE REPORTE PDF - ÍNTEGRAMENTE
# =================================================================
# Reemplaza la "descarga simulada" del notebook original, que solo
# imprimía las líneas del reporte en la consola sin generar ningún
# archivo real. Acá se genera un PDF descargable de verdad.
# =================================================================

import io
from datetime import datetime
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable

MAGENTA = colors.HexColor("#A01A4D")
BORDO = colors.HexColor("#36091A")
GRIS = colors.HexColor("#7C746C")


def generar_pdf_reporte(nombre_usuario: str, eventos: list[str]) -> bytes:
    """Genera el PDF del reporte integral de la sesión. `eventos` es la
    lista de strings acumulados durante la sesión (equivalente a
    REPORTE_TEXTUAL_SESION del notebook original, pero ahora sí se
    convierte en un archivo real)."""
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=letter,
        topMargin=0.8 * inch, bottomMargin=0.8 * inch,
        leftMargin=0.9 * inch, rightMargin=0.9 * inch,
    )

    styles = getSampleStyleSheet()
    titulo = ParagraphStyle("Titulo", parent=styles["Title"], textColor=BORDO, fontSize=22)
    subtitulo = ParagraphStyle("Subtitulo", parent=styles["Normal"], textColor=MAGENTA, fontSize=12, spaceAfter=14)
    meta = ParagraphStyle("Meta", parent=styles["Normal"], textColor=GRIS, fontSize=10, spaceAfter=4)
    cuerpo = ParagraphStyle("Cuerpo", parent=styles["Normal"], fontSize=11, leading=16, spaceAfter=10)
    despedida = ParagraphStyle("Despedida", parent=styles["Italic"], textColor=MAGENTA, fontSize=12, spaceBefore=20)

    elementos = []
    elementos.append(Paragraph("ÍntegraMENTE", titulo))
    elementos.append(Paragraph("Reporte integral de tu sesión", subtitulo))
    elementos.append(Paragraph(f"Usuario: {nombre_usuario or 'Invitado'}", meta))
    elementos.append(Paragraph(f"Fecha: {datetime.now().strftime('%d/%m/%Y %H:%M')}", meta))
    elementos.append(HRFlowable(width="100%", color=MAGENTA, thickness=1, spaceBefore=10, spaceAfter=16))

    for linea in eventos:
        elementos.append(Paragraph(linea, cuerpo))

    elementos.append(HRFlowable(width="100%", color=GRIS, thickness=0.5, spaceBefore=10, spaceAfter=10))
    elementos.append(Paragraph(
        "Gracias por regalarte este espacio de estructura y transformación. "
        "Tu sesión integral ha finalizado con éxito.",
        despedida
    ))

    doc.build(elementos)
    buffer.seek(0)
    return buffer.read()
