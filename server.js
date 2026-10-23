// ===============================
// TASKMETER STUDIO — BACKEND API
// Production-ready feature-rich backend
// ===============================

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const db = new sqlite3.Database("data.db");

// ===============================
// DATABASE SETUP & MIGRATIONS
// ===============================
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password TEXT,
      is_admin INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT,
      client_name TEXT,
      hourly_rate REAL DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      budget_hours REAL DEFAULT 0,
      milestones TEXT DEFAULT '[]',
      share_token TEXT,
      status TEXT DEFAULT 'In Progress',
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      started_at INTEGER,
      stopped_at INTEGER,
      notes TEXT,
      billable INTEGER DEFAULT 1,
      FOREIGN KEY(project_id) REFERENCES projects(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      sender TEXT,
      content TEXT,
      created_at INTEGER,
      FOREIGN KEY(project_id) REFERENCES projects(id)
    )
  `);
});

// ===============================
// AUTH HELPERS
// ===============================
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Missing authorization token" });

  try {
    req.user = jwt.verify(token, "SECRET_KEY");
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ===============================
// AUTH ROUTES
// ===============================
app.post("/signup", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  
  const hash = await bcrypt.hash(password, 10);

  db.run(
    `INSERT INTO users (email, password) VALUES (?, ?)`,
    [email, hash],
    function (err) {
      if (err) return res.json({ error: "Email already registered" });

      const token = jwt.sign({ id: this.lastID, email }, "SECRET_KEY");
      res.json({ token, email });
    }
  );
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });

  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (!user) return res.json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user.id, email: user.email, is_admin: user.is_admin }, "SECRET_KEY");
    res.json({ token, email: user.email });
  });
});

// ===============================
// PROJECT ROUTES
// ===============================
app.post("/projects", auth, (req, res) => {
  const { name, client_name, hourly_rate, currency, budget_hours, milestones } = req.body;
  if (!name || !client_name) return res.status(400).json({ error: "Name and Client Name are required" });

  const share_token = 'meter-' + Math.random().toString(36).substring(2, 9);
  const milestonesJson = typeof milestones === 'string' ? milestones : JSON.stringify(milestones || []);

  db.run(
    `INSERT INTO projects (user_id, name, client_name, hourly_rate, currency, budget_hours, milestones, share_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, name, client_name, hourly_rate || 0, currency || 'USD', budget_hours || 0, milestonesJson, share_token],
    function (err) {
      if (err) return res.json({ error: "Error creating project" });
      res.json({ projectId: this.lastID, share_token });
    }
  );
});

app.get("/projects", auth, (req, res) => {
  db.all(`SELECT * FROM projects WHERE user_id = ? ORDER BY id DESC`, [req.user.id], async (err, rows) => {
    if (err) return res.json({ error: err.message });

    const projects = await Promise.all(
      rows.map(row => new Promise(resolve => {
        db.all(`SELECT * FROM time_entries WHERE project_id = ?`, [row.id], (err2, entries) => {
          let totalMs = 0;
          let billableMs = 0;
          let running = false;

          (entries || []).forEach(e => {
            const dur = e.stopped_at ? (e.stopped_at - e.started_at) : (Date.now() - e.started_at);
            totalMs += dur;
            if (e.billable !== 0) billableMs += dur;
            if (!e.stopped_at) running = true;
          });

          const hours = totalMs / 3600000;
          const billableHours = billableMs / 3600000;
          const cost = billableHours * (row.hourly_rate || 0);

          let parsedMilestones = [];
          try { parsedMilestones = JSON.parse(row.milestones || '[]'); } catch (e) {}

          resolve({
            ...row,
            running,
            hours,
            billableHours,
            cost,
            milestones: parsedMilestones,
            entriesCount: (entries || []).length
          });
        });
      }))
    );

    res.json({ projects });
  });
});

app.delete("/projects/:id", auth, (req, res) => {
  const projectId = req.params.id;
  db.run(`DELETE FROM time_entries WHERE project_id = ?`, [projectId], () => {
    db.run(`DELETE FROM messages WHERE project_id = ?`, [projectId], () => {
      db.run(`DELETE FROM projects WHERE id = ? AND user_id = ?`, [projectId, req.user.id], function(err) {
        if (err) return res.json({ error: "Could not delete project" });
        res.json({ message: "Project deleted successfully" });
      });
    });
  });
});

// ===============================
// TIME ENTRIES CONTROLS
// ===============================
app.post("/projects/:id/start", auth, (req, res) => {
  const projectId = req.params.id;

  db.get(`SELECT * FROM projects WHERE id = ? AND user_id = ?`, [projectId, req.user.id], (err, project) => {
    if (!project) return res.json({ error: "Project not found" });

    db.all(
      `SELECT te.*
       FROM time_entries te
       JOIN projects p ON te.project_id = p.id
       WHERE p.user_id = ? AND te.stopped_at IS NULL`,
      [req.user.id],
      (err2, rows) => {
        if (rows && rows.length > 0) return res.json({ error: "Another project clock is currently running" });

        db.run(
          `INSERT INTO time_entries (project_id, started_at, billable) VALUES (?, ?, 1)`,
          [projectId, Date.now()],
          () => res.json({ message: "Clock started" })
        );
      }
    );
  });
});

app.post("/projects/:id/stop", auth, (req, res) => {
  const projectId = req.params.id;
  const { notes } = req.body || {};

  db.get(`SELECT * FROM time_entries WHERE project_id = ? AND stopped_at IS NULL`, [projectId], (err, entry) => {
    if (!entry) return res.json({ error: "No running clock for this project" });

    db.run(
      `UPDATE time_entries SET stopped_at = ?, notes = COALESCE(?, notes) WHERE id = ?`,
      [Date.now(), notes, entry.id],
      () => res.json({ message: "Clock stopped" })
    );
  });
});

app.get("/projects/:id/entries", auth, (req, res) => {
  db.all(`SELECT * FROM time_entries WHERE project_id = ? ORDER BY started_at DESC`, [req.params.id], (err, entries) => {
    res.json({ entries: entries || [] });
  });
});

app.post("/projects/:id/entries", auth, (req, res) => {
  const { started_at, stopped_at, notes, billable } = req.body;
  db.run(
    `INSERT INTO time_entries (project_id, started_at, stopped_at, notes, billable) VALUES (?, ?, ?, ?, ?)`,
    [req.params.id, started_at, stopped_at, notes || '', billable !== false ? 1 : 0],
    function (err) {
      if (err) return res.json({ error: "Failed to add manual entry" });
      res.json({ entryId: this.lastID });
    }
  );
});

// ===============================
// MESSAGING & NOTES
// ===============================
app.post("/projects/:id/messages", auth, (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: "Message content required" });

  db.run(
    `INSERT INTO messages (project_id, sender, content, created_at)
     VALUES (?, 'freelancer', ?, ?)`,
    [req.params.id, content, Date.now()],
    () => res.json({ message: "Message sent" })
  );
});

// ===============================
// CLIENT LIVE VIEW & CLIENT MESSAGING
// ===============================
app.post("/live/:token/messages", (req, res) => {
  const token = req.params.token;
  const { content, senderName } = req.body;
  if (!content) return res.status(400).json({ error: "Message content required" });

  db.get(`SELECT * FROM projects WHERE share_token = ?`, [token], (err, project) => {
    if (!project) return res.status(404).json({ error: "Project not found" });

    db.run(
      `INSERT INTO messages (project_id, sender, content, created_at)
       VALUES (?, ?, ?, ?)`,
      [project.id, senderName || 'client', content, Date.now()],
      () => res.json({ message: "Client message sent" })
    );
  });
});

app.post("/live/:token/milestones/:idx/approve", (req, res) => {
  const token = req.params.token;
  const mIdx = parseInt(req.params.idx);

  db.get(`SELECT * FROM projects WHERE share_token = ?`, [token], (err, project) => {
    if (!project) return res.status(404).json({ error: "Project not found" });

    let milestones = [];
    try { milestones = JSON.parse(project.milestones || '[]'); } catch (e) {}

    if (milestones[mIdx]) {
      milestones[mIdx].completed = true;
      db.run(
        `UPDATE projects SET milestones = ? WHERE id = ?`,
        [JSON.stringify(milestones), project.id],
        () => {
          db.run(
            `INSERT INTO messages (project_id, sender, content, created_at) VALUES (?, 'client', ?, ?)`,
            [project.id, `Client has APPROVED milestone: "${milestones[mIdx].name}"`, Date.now()]
          );
          res.json({ ok: true, milestones });
        }
      );
    } else {
      res.status(400).json({ error: "Milestone index not found" });
    }
  });
});

app.get("/live/:token", (req, res) => {
  const token = req.params.token;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  function sendUpdate() {
    db.get(`SELECT * FROM projects WHERE share_token = ?`, [token], (err, project) => {
      if (!project) return res.write(`event: error\ndata: Project not found\n\n`);

      db.all(`SELECT * FROM time_entries WHERE project_id = ?`, [project.id], (err2, entries) => {
        let totalMs = 0;
        let billableMs = 0;
        let running = false;

        (entries || []).forEach(e => {
          const dur = e.stopped_at ? (e.stopped_at - e.started_at) : (Date.now() - e.started_at);
          totalMs += dur;
          if (e.billable !== 0) billableMs += dur;
          if (!e.stopped_at) running = true;
        });

        const hours = totalMs / 3600000;
        const billableHours = billableMs / 3600000;
        const cost = billableHours * (project.hourly_rate || 0);

        let parsedMilestones = [];
        try { parsedMilestones = JSON.parse(project.milestones || '[]'); } catch (e) {}

        db.all(
          `SELECT * FROM messages WHERE project_id = ? ORDER BY created_at ASC`,
          [project.id],
          (err3, msgs) => {
            res.write(`data: ${JSON.stringify({
              project: { ...project, milestones: parsedMilestones },
              running,
              hours,
              billableHours,
              cost,
              messages: msgs || []
            })}\n\n`);
          }
        );
      });
    });
  }

  sendUpdate();
  const interval = setInterval(sendUpdate, 2000);

  req.on("close", () => clearInterval(interval));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`TaskMeter Studio API live on port ${PORT}`));
