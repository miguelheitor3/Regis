"""
Backend simples para registrar o último horário de Regis detectado e
enviar uma única notificação ao Discord por ciclo de 61 minutos.

Instalação:
    pip install flask requests

Executar:
    python regi_backend.py

Por padrão:
    http://127.0.0.1:5050
"""

from flask import Flask, jsonify
import requests
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
import os

app = Flask(__name__)

# O webhook fica no backend, não no script do jogo.
# Recomendo definir DISCORD_WEBHOOK_URL como variável de ambiente.
DISCORD_WEBHOOK_URL = os.environ.get(
    "DISCORD_WEBHOOK_URL",
    ""
)

DB_PATH = Path(__file__).with_name("regi_backend.db")
CYCLE_MINUTES = 61

MESSAGE_TEMPLATE = (
    "Horário atual de Regis Detectado às {current}, "
    "estimativa do próximo: {next_time}. "
    "ordem padrão = Terrakion, Cobalion, Virizion"
)


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS regi_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                detected_at TEXT NOT NULL
            )
        """)
        conn.commit()


def send_discord(message):
    if not DISCORD_WEBHOOK_URL:
        print("[DISCORD] DISCORD_WEBHOOK_URL não configurado.")
        return False

    try:
        response = requests.post(
            DISCORD_WEBHOOK_URL,
            json={"content": message},
            timeout=2.0
        )
        response.raise_for_status()
        return True
    except requests.RequestException as exc:
        print(f"[DISCORD] Falha ao enviar: {exc}")
        return False


@app.post("/regi/detected")
def regi_detected():
    """
    Recebe uma detecção de Regis.

    Se já houve uma detecção nos últimos 61 minutos, não envia novamente.
    Se passou o ciclo, registra a nova detecção e envia ao Discord.
    """
    now = datetime.now()
    now_text = now.strftime("%Y-%m-%d %H:%M:%S")

    with sqlite3.connect(DB_PATH, timeout=5.0) as conn:
        conn.execute("BEGIN IMMEDIATE")

        row = conn.execute(
            "SELECT detected_at FROM regi_state WHERE id = 1"
        ).fetchone()

        if row:
            last = datetime.strptime(row[0], "%Y-%m-%d %H:%M:%S")
            next_spawn = last + timedelta(minutes=CYCLE_MINUTES)

            # Ainda estamos no mesmo ciclo: não envia novamente.
            if now < next_spawn:
                remaining = int((next_spawn - now).total_seconds())
                return jsonify({
                    "send": False,
                    "reason": "same_cycle",
                    "last_detected": last.strftime("%H:%M"),
                    "next_estimate": next_spawn.strftime("%H:%M"),
                    "remaining_seconds": remaining
                })

        # Novo ciclo.
        conn.execute("""
            INSERT INTO regi_state (id, detected_at)
            VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET detected_at = excluded.detected_at
        """, (now_text,))
        conn.commit()

    next_time = now + timedelta(minutes=CYCLE_MINUTES)

    message = MESSAGE_TEMPLATE.format(
        current=now.strftime("%H:%M"),
        next_time=next_time.strftime("%H:%M")
    )

    sent = send_discord(message)

    return jsonify({
        "send": True,
        "discord_sent": sent,
        "current": now.strftime("%H:%M"),
        "next_estimate": next_time.strftime("%H:%M"),
        "message": message
    })


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    init_db()
    print("========================================")
    print("       BACKEND TIMER DE REGIS")
    print("========================================")
    print("API: http://127.0.0.1:5050")
    print("Ciclo: 61 minutos")
    print("----------------------------------------")
    app.run(host="127.0.0.1", port=5050, threaded=True)
