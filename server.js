const express = require("express");
const { Pool } = require("pg");

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const CYCLE_MINUTES = 61;

if (!process.env.DATABASE_URL) {
    console.error("ERRO: DATABASE_URL não configurada.");
    process.exit(1);
}

if (!DISCORD_WEBHOOK_URL) {
    console.error("ERRO: DISCORD_WEBHOOK_URL não configurada.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


// ============================================================
// BANCO DE DADOS
// ============================================================

async function initDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS regi_state (
            id INTEGER PRIMARY KEY,
            detected_at TIMESTAMPTZ NOT NULL
        )
    `);

    console.log("[DB] Banco inicializado.");
}


// ============================================================
// DISCORD
// ============================================================

async function sendDiscord(currentTime, nextTime) {

    const response = await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({
            embeds: [
                {
                    title: "🟢 Regis Detectado!",
                    description:
                        "Os Regis foram detectados e o próximo ciclo foi estimado.",
                    
                    color: 5763719,

                    fields: [
                        {
                            name: "🕐 Horário detectado",
                            value: `**${currentTime}**`,
                            inline: true
                        },
                        {
                            name: "⏰ Próximo spawn",
                            value: `**${nextTime}**`,
                            inline: true
                        },
                        {
                            name: "⚔️ Ordem padrão",
                            value:
                                "Terrakion → Cobalion → Virizion",
                            inline: false
                        }
                    ],

                    footer: {
                        text: "OTP Online Tracker"
                    },

                    timestamp: new Date().toISOString()
                }
            ]
        })
    });

    if (!response.ok) {

        const body = await response.text();

        throw new Error(
            `Discord HTTP ${response.status}: ${body}`
        );
    }
}


// ============================================================
// FORMATA HORÁRIO BRASIL
// ============================================================

function formatTime(date) {

    return new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    }).format(date);
}


// ============================================================
// HOME
// ============================================================

app.get("/", (req, res) => {

    res.json({
        status: "ok",
        service: "regi-timer"
    });

});


// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", async (req, res) => {

    try {

        await pool.query("SELECT 1");

        res.status(200).json({
            status: "healthy"
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            status: "unhealthy"
        });

    }

});


// ============================================================
// REGI DETECTADO
// ============================================================

app.post("/regi/detected", async (req, res) => {

    const client = await pool.connect();

    try {

        await client.query("BEGIN");


        // ====================================================
        // BLOQUEIA A LINHA PARA EVITAR DUPLICIDADE
        // ====================================================

        const result = await client.query(`
            SELECT detected_at
            FROM regi_state
            WHERE id = 1
            FOR UPDATE
        `);


        const now = new Date();


        // ====================================================
        // JÁ EXISTE UM REGISTRO?
        // ====================================================

        if (result.rows.length > 0) {

            const lastDetected =
                new Date(result.rows[0].detected_at);


            const nextSpawn = new Date(
                lastDetected.getTime() +
                CYCLE_MINUTES * 60 * 1000
            );


            // =================================================
            // AINDA ESTÁ NO MESMO CICLO
            // =================================================

            if (now < nextSpawn) {

                await client.query("COMMIT");

                return res.json({

                    send: false,

                    reason: "same_cycle",

                    last_detected:
                        formatTime(lastDetected),

                    next_estimate:
                        formatTime(nextSpawn)

                });

            }

        }


        // ====================================================
        // NOVO CICLO
        // ====================================================

        await client.query(`
            INSERT INTO regi_state (
                id,
                detected_at
            )

            VALUES (
                1,
                $1
            )

            ON CONFLICT (id)

            DO UPDATE SET
                detected_at = EXCLUDED.detected_at
        `, [now]);


        await client.query("COMMIT");


        // ====================================================
        // CALCULA PRÓXIMO REGIS
        // ====================================================

        const nextSpawn = new Date(
            now.getTime() +
            CYCLE_MINUTES * 60 * 1000
        );


        const currentText =
            formatTime(now);

        const nextText =
            formatTime(nextSpawn);


        // ====================================================
        // MENSAGEM EXATA
        // ====================================================

        const message =
            `Horário atual de Regis Detectado às ${currentText}, ` +
            `estimativa do próximo: ${nextText}. ` +
            `ordem padrão = Terrakion, Cobalion, Virizion`;


        // ====================================================
        // ENVIA DISCORD
        // ====================================================

        try {

            await sendDiscord(
                currentText,
                nextText
            );

        } catch (discordError) {

            console.error(
                "[DISCORD]",
                discordError
            );


            return res.status(502).json({

                send: true,

                discord_sent: false,

                current: currentText,

                next_estimate: nextText

            });

        }


        // ====================================================
        // RESPOSTA
        // ====================================================

        return res.json({

            send: true,

            discord_sent: true,

            current: currentText,

            next_estimate: nextText,

            message: message

        });


    } catch (error) {

        try {
            await client.query("ROLLBACK");
        } catch (_) {}


        console.error(
            "[REGI]",
            error
        );


        return res.status(500).json({

            error: "backend_error"

        });


    } finally {

        client.release();

    }

});


// ============================================================
// INICIALIZAÇÃO
// ============================================================

initDatabase()

    .then(() => {

        app.listen(
            PORT,
            "0.0.0.0",
            () => {

                console.log(
                    `Regi backend rodando na porta ${PORT}`
                );

            }
        );

    })

    .catch((error) => {

        console.error(
            "Falha ao iniciar banco:",
            error
        );

        process.exit(1);

    });


// ============================================================
// ENCERRAMENTO
// ============================================================

process.on("SIGTERM", async () => {

    await pool.end();

    process.exit(0);

});
