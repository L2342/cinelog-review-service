require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// URL interna del movie-service inyectada por variable de entorno
const MOVIE_SERVICE_URL = process.env.MOVIE_SERVICE_URL;

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id         SERIAL PRIMARY KEY,
      movie_id   INTEGER NOT NULL,
      movie_title VARCHAR(200),
      rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
      comment    TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('[review-service] Tabla reviews lista.');
}

// ── Health check ──────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'review-service' });
});

// ── POST /reviews — crear reseña ──────────────────────
// Valida que la película exista llamando a movie-service internamente
app.post('/reviews', async (req, res) => {
  const { movie_id, rating, comment } = req.body;

  if (!movie_id || !rating) {
    return res.status(400).json({ error: 'movie_id y rating son requeridos.' });
  }
  if (rating < 1 || rating > 10) {
    return res.status(400).json({ error: 'rating debe estar entre 1 y 10.' });
  }

  // ── Comunicación interna: verificar que la película existe ──
  let movieTitle;
  try {
    const movieRes = await fetch(`${MOVIE_SERVICE_URL}/movies/${movie_id}`);
    if (movieRes.status === 404) {
      return res.status(404).json({
        error: `No existe ninguna película con id ${movie_id} en movie-service.`
      });
    }
    if (!movieRes.ok) {
      return res.status(502).json({ error: 'Error al comunicarse con movie-service.' });
    }
    const movie = await movieRes.json();
    movieTitle = movie.title;
    console.log(`[review-service] Película verificada: "${movieTitle}" (id: ${movie_id})`);
  } catch (err) {
    console.error('[review-service] No se pudo contactar movie-service:', err.message);
    return res.status(503).json({ error: 'movie-service no disponible.' });
  }

  // ── Guardar reseña ──
  try {
    const result = await pool.query(
      `INSERT INTO reviews (movie_id, movie_title, rating, comment)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [movie_id, movieTitle, rating, comment || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno al guardar la reseña.' });
  }
});

// ── GET /reviews/:movieId — listar reseñas de una peli ─
app.get('/reviews/:movieId', async (req, res) => {
  const { movieId } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM reviews WHERE movie_id = $1 ORDER BY created_at DESC',
      [movieId]
    );
    res.json({
      movie_id: parseInt(movieId),
      total: result.rows.length,
      reviews: result.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al consultar reseñas.' });
  }
});

const PORT = process.env.PORT || 3002;
init().then(() => {
  app.listen(PORT, () => console.log(`[review-service] Corriendo en puerto ${PORT}`));
});
