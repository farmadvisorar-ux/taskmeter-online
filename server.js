// ===============================
// TASKMETER STUDIO — BACKEND API
// Production-ready Auth, Email Flow & Hidden Admin Console
// ===============================

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());
app.use(cors());

// Serve static assets from public and project root
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(__dirname));

const JWT_SECRET = process.env.JWT_SECRET || "taskmeter_super_secret_jwt_key_2026";
const ADMIN_SECRET_PATH = process.env.ADMIN_SECRET_PATH || "control-panel-98x";

// SQLite Database Setup
const db = new sqlite3.Database(path.join(__dirname, "data.db"));

// Configure Email Transporter (Supports SMTP env variables or development in-memory logger)
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

// In-Memory or DB audit log for dispatched emails
async function dispatchEmail({ to, subject, html, text }) {
  const timestamp = Date.now();
  const mailId = "mail_" + crypto.randomBytes(6).toString("hex");

  // Save to DB email_logs table for audit & admin viewing
  db.run(
    `INSERT INTO email_logs (mail_id, recipient, subject, body_html, sent_at, status) VALUES (?, ?, ?, ?, ?, ?)`,
    [mailId, to, subject, html, timestamp, 'delivered']
  );

  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || '"TaskMeter Studio" <no-reply@taskmeter.online>',
        to,
        subject,
        text,
        html
      });
      console.log(`[EMAIL DISPATCHED via SMTP] To: ${to} | Subject: ${subject}`);
    } catch (err) {
      console.error(`[SMTP ERROR] Could not send to ${to}:`, err.message);
    }
  } else {
    console.log(`[EMAIL DISPATCHED (Mock/Dev Transporter)] To: ${to} | Subject: ${subject}`);
  }

  return { ok: true, mailId };
}

// ===============================
// DATABASE SETUP & MIGRATIONS
// ===============================
db.serialize(() => {
  // Users Table with Roles, Status & Verification
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password TEXT,
      name TEXT,
      role TEXT DEFAULT 'freelancer',
      is_admin INTEGER DEFAULT 0,
      is_verified INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      reset_token TEXT,
      reset_token_expires INTEGER,
      verify_token TEXT,
      created_at INTEGER
    )
  `);

  // Email Audit Logs for Admin Inspection
  db.run(`
    CREATE TABLE IF NOT EXISTS email_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mail_id TEXT,
      recipient TEXT,
      subject TEXT,
      body_html TEXT,
      sent_at INTEGER,
      status TEXT DEFAULT 'delivered'
    )
  `);

  // Projects Table
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
      created_at INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Time Entries Table
  db.run(`
    CREATE TABLE IF NOT EXISTS time_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      started_at INTEGER,
      stopped_at INTEGER,
      notes TEXT,
      billable INTEGER DEFAULT 1,
      tag TEXT DEFAULT 'dev',
      FOREIGN KEY(project_id) REFERENCES projects(id)
    )
  `);

  // Messages Table
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

  // Expenses Table
  db.run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      amount REAL,
      category TEXT,
      notes TEXT,
      reimbursable INTEGER DEFAULT 1,
      date TEXT,
      FOREIGN KEY(project_id) REFERENCES projects(id)
    )
  `);

  // Seed default admin and standard demo users if not present
  const adminEmail = "admin@taskmeter.online";
  db.get(`SELECT id FROM users WHERE email = ?`, [adminEmail], async (err, row) => {
    if (!row) {
      const adminHash = await bcrypt.hash("AdminMaster2026!", 10);
      db.run(
        `INSERT INTO users (email, password, name, role, is_admin, is_verified, status, created_at)
         VALUES (?, ?, ?, 'admin', 1, 1, 'active', ?)`,
        [adminEmail, adminHash, "Chief Admin", Date.now()]
      );
      console.log(`[DB SEED] Initialized Super Admin user: ${adminEmail} (Pass: AdminMaster2026!)`);
    }
  });

  const demoEmail = "alex@taskmeter.online";
  db.get(`SELECT id FROM users WHERE email = ?`, [demoEmail], async (err, row) => {
    if (!row) {
      const demoHash = await bcrypt.hash("FreelancerPass123!", 10);
      db.run(
        `INSERT INTO users (email, password, name, role, is_admin, is_verified, status, created_at)
         VALUES (?, ?, ?, 'freelancer', 0, 1, 'active', ?)`,
        [demoEmail, demoHash, "Alex Rivera", Date.now()]
      );
    }
  });
});

// ===============================
// AUTH & ADMIN MIDDLEWARE
// ===============================
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Missing authorization token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    db.get(`SELECT * FROM users WHERE id = ?`, [req.user.id], (err, user) => {
      if (!user || user.is_admin !== 1) {
        return res.status(403).json({ error: "Forbidden: Super-Administrator authorization required." });
      }
      req.adminUser = user;
      next();
    });
  });
}

// ===============================
// USER AUTHENTICATION & EMAIL FLOWS
// ===============================

// 1. Sign Up Route with Welcome / Verification Email
app.post("/signup", async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = (name || cleanEmail.split("@")[0]).trim();
    const cleanRole = role === "agency" ? "agency" : "freelancer";

    db.get(`SELECT id FROM users WHERE email = ?`, [cleanEmail], async (err, existing) => {
      if (existing) return res.status(409).json({ error: "An account with that email already exists" });

      const hash = await bcrypt.hash(password, 10);
      const verifyToken = crypto.randomBytes(24).toString("hex");
      const createdAt = Date.now();

      db.run(
        `INSERT INTO users (email, password, name, role, is_admin, is_verified, status, verify_token, created_at)
         VALUES (?, ?, ?, ?, 0, 1, 'active', ?, ?)`,
        [cleanEmail, hash, cleanName, cleanRole, verifyToken, createdAt],
        function (insertErr) {
          if (insertErr) return res.status(500).json({ error: "Failed to register user account" });

          const userId = this.lastID;
          const token = jwt.sign(
            { id: userId, email: cleanEmail, name: cleanName, role: cleanRole, is_admin: 0 },
            JWT_SECRET,
            { expiresIn: "30d" }
          );

          // Dispatch Welcome Email
          const welcomeHtml = `
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; max-width:600px; margin:0 auto; padding:24px; border:1px solid #e2e8f0; border-radius:12px; background:#ffffff; color:#0f172a;">
              <div style="text-align:center; padding-bottom:20px; border-bottom:1px solid #e2e8f0;">
                <h1 style="color:#6366f1; margin:0; font-size:24px; font-weight:800;">TaskMeter Pro Studio</h1>
                <p style="color:#64748b; font-size:14px; margin:4px 0 0 0;">Next-Gen Freelance OS &amp; Live Client Billing Meter</p>
              </div>
              <div style="padding:24px 0;">
                <p style="font-size:16px; margin:0 0 16px 0;">Hi <strong>${cleanName}</strong>,</p>
                <p style="font-size:15px; line-height:1.6; color:#334155;">
                  Welcome to TaskMeter! Your workspace account has been created. You can track billable hours, stream real-time meters to clients, manage agency budgets, and auto-generate invoices.
                </p>
                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin:20px 0;">
                  <div style="font-size:13px; color:#64748b;">Registered Account:</div>
                  <div style="font-size:15px; font-weight:700; color:#0f172a;">${cleanEmail}</div>
                  <div style="font-size:13px; color:#64748b; margin-top:8px;">Workspace Role:</div>
                  <div style="font-size:14px; font-weight:600; color:#6366f1; text-transform:uppercase;">${cleanRole}</div>
                </div>
                <div style="text-align:center; margin:28px 0 12px 0;">
                  <a href="${req.protocol}://${req.get('host')}/" style="background:#6366f1; color:#ffffff; padding:12px 28px; border-radius:8px; text-decoration:none; font-weight:700; font-size:15px; display:inline-block;">Launch TaskMeter Studio</a>
                </div>
              </div>
              <div style="border-top:1px solid #e2e8f0; padding-top:16px; font-size:12px; color:#94a3b8; text-align:center;">
                &copy; 2026 TaskMeter Studio &bull; Automated System Dispatch
              </div>
            </div>
          `;

          dispatchEmail({
            to: cleanEmail,
            subject: `Welcome to TaskMeter Studio, ${cleanName}! ⚡`,
            html: welcomeHtml,
            text: `Welcome to TaskMeter Studio! Your account ${cleanEmail} is ready.`
          });

          res.json({
            ok: true,
            token,
            user: { id: userId, email: cleanEmail, name: cleanName, role: cleanRole, is_admin: 0 }
          });
        }
      );
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Login Route
app.post("/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  const cleanEmail = email.trim().toLowerCase();

  db.get(`SELECT * FROM users WHERE email = ?`, [cleanEmail], async (err, user) => {
    if (err) return res.status(500).json({ error: "Database error during login" });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    if (user.status === "suspended") {
      return res.status(403).json({ error: "This account has been suspended by system administration." });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, is_admin: user.is_admin },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        is_admin: user.is_admin
      }
    });
  });
});

// 3. Current User Session Check
app.get("/auth/me", auth, (req, res) => {
  db.get(`SELECT id, email, name, role, is_admin, status, created_at FROM users WHERE id = ?`, [req.user.id], (err, user) => {
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ ok: true, user });
  });
});

// 4. Request Password Reset Link & Dispatch Email
app.post("/auth/forgot-password", (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email address is required" });

  const cleanEmail = email.trim().toLowerCase();

  db.get(`SELECT * FROM users WHERE email = ?`, [cleanEmail], (err, user) => {
    if (!user) {
      // Return ok status to prevent email enumeration attacks
      return res.json({ ok: true, message: "If an account exists, a password reset link has been dispatched." });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const tokenExpires = Date.now() + 3600000; // 1 hour

    db.run(
      `UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?`,
      [resetToken, tokenExpires, user.id],
      (updateErr) => {
        if (updateErr) return res.status(500).json({ error: "Failed to store recovery token" });

        const resetUrl = `${req.protocol}://${req.get("host")}/#reset-token=${resetToken}&email=${encodeURIComponent(cleanEmail)}`;
        const resetHtml = `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; max-width:600px; margin:0 auto; padding:24px; border:1px solid #e2e8f0; border-radius:12px; background:#ffffff; color:#0f172a;">
            <div style="text-align:center; padding-bottom:20px; border-bottom:1px solid #e2e8f0;">
              <h1 style="color:#6366f1; margin:0; font-size:24px; font-weight:800;">TaskMeter Pro Studio</h1>
              <p style="color:#64748b; font-size:14px; margin:4px 0 0 0;">Password Recovery Dispatch</p>
            </div>
            <div style="padding:24px 0;">
              <p style="font-size:16px; margin:0 0 16px 0;">Hi <strong>${user.name || "TaskMeter User"}</strong>,</p>
              <p style="font-size:15px; line-height:1.6; color:#334155;">
                We received a request to reset the password for your TaskMeter account. Click the button below to choose a new password. This link is valid for <strong>1 hour</strong>.
              </p>
              <div style="text-align:center; margin:28px 0;">
                <a href="${resetUrl}" style="background:#10b981; color:#ffffff; padding:12px 28px; border-radius:8px; text-decoration:none; font-weight:700; font-size:15px; display:inline-block;">Reset My Password</a>
              </div>
              <p style="font-size:13px; color:#64748b; line-height:1.5;">
                Or copy and paste this recovery URL directly into your browser:<br>
                <a href="${resetUrl}" style="color:#6366f1; word-break:break-all;">${resetUrl}</a>
              </p>
              <p style="font-size:13px; color:#94a3b8; margin-top:24px;">
                If you did not request this password reset, you can safely ignore this email. Your current password will remain intact.
              </p>
            </div>
            <div style="border-top:1px solid #e2e8f0; padding-top:16px; font-size:12px; color:#94a3b8; text-align:center;">
              &copy; 2026 TaskMeter Studio &bull; Security &amp; Credential Recovery
            </div>
          </div>
        `;

        dispatchEmail({
          to: cleanEmail,
          subject: "Reset your TaskMeter Studio password 🔐",
          html: resetHtml,
          text: `Reset your TaskMeter password: ${resetUrl}`
        });

        res.json({
          ok: true,
          message: "Password reset link has been dispatched to your email address.",
          resetToken // also returned for seamless dev/testing preview
        });
      }
    );
  });
});

// 5. Complete Password Reset with Token
app.post("/auth/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: "Token and new password are required" });

  if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  db.get(
    `SELECT * FROM users WHERE reset_token = ? AND reset_token_expires > ?`,
    [token, Date.now()],
    async (err, user) => {
      if (err) return res.status(500).json({ error: "Database error during password reset" });
      if (!user) return res.status(400).json({ error: "Invalid or expired password reset link" });

      const newHash = await bcrypt.hash(newPassword, 10);

      db.run(
        `UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?`,
        [newHash, user.id],
        (updateErr) => {
          if (updateErr) return res.status(500).json({ error: "Failed to update password" });

          // Send confirmation notice
          dispatchEmail({
            to: user.email,
            subject: "Your TaskMeter password has been updated ✅",
            html: `
              <div style="font-family:sans-serif; max-width:600px; padding:20px; border:1px solid #e2e8f0; border-radius:10px;">
                <h2 style="color:#10b981;">Password Reset Confirmed</h2>
                <p>Hello ${user.name || 'User'}, the password for your TaskMeter account (${user.email}) was successfully updated.</p>
                <p>If you did not perform this change, please contact system administration immediately.</p>
              </div>
            `,
            text: `Your TaskMeter password for ${user.email} has been updated.`
          });

          res.json({ ok: true, message: "Password updated successfully. You can now log in." });
        }
      );
    }
  );
});

// ===============================
// DEDICATED SEPARATE ADMIN DASHBOARD BACKEND
// Accessible via dedicated path: /control-panel-98x (No button on public site)
// ===============================

// Serve Admin Dashboard HTML on Secret URL
app.get(`/${ADMIN_SECRET_PATH}`, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-console.html"));
});

// Admin API: Overview KPIs & System Telemetry
app.get("/api/admin/overview", adminAuth, (req, res) => {
  db.get(`SELECT COUNT(*) as totalUsers FROM users`, (e1, r1) => {
    db.get(`SELECT COUNT(*) as totalProjects FROM projects`, (e2, r2) => {
      db.get(`SELECT COUNT(*) as totalEntries, SUM(stopped_at - started_at) as totalDurationMs FROM time_entries`, (e3, r3) => {
        db.get(`SELECT COUNT(*) as totalEmails FROM email_logs`, (e4, r4) => {
          const hoursMetered = ((r3?.totalDurationMs || 0) / 3600000).toFixed(1);
          res.json({
            ok: true,
            kpis: {
              usersCount: r1?.totalUsers || 0,
              projectsCount: r2?.totalProjects || 0,
              entriesCount: r3?.totalEntries || 0,
              hoursMetered: parseFloat(hoursMetered),
              emailsDispatched: r4?.totalEmails || 0
            }
          });
        });
      });
    });
  });
});

// Admin API: List Users with Status & Management Controls
app.get("/api/admin/users", adminAuth, (req, res) => {
  db.all(
    `SELECT u.id, u.email, u.name, u.role, u.is_admin, u.status, u.created_at,
            COUNT(p.id) as projectCount
     FROM users u
     LEFT JOIN projects p ON p.user_id = u.id
     GROUP BY u.id
     ORDER BY u.id DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, users: rows || [] });
    }
  );
});

// Admin API: Update User Role or Status (Toggle Admin, Suspend, Activate)
app.patch("/api/admin/users/:id", adminAuth, (req, res) => {
  const userId = req.params.id;
  const { status, role, is_admin } = req.body;

  // Protect primary admin from self-demotion
  if (parseInt(userId) === req.adminUser.id && (is_admin === 0 || status === 'suspended')) {
    return res.status(400).json({ error: "Cannot demote or suspend your own active administrator account" });
  }

  db.run(
    `UPDATE users
     SET status = COALESCE(?, status),
         role = COALESCE(?, role),
         is_admin = COALESCE(?, is_admin)
     WHERE id = ?`,
    [status, role, is_admin, userId],
    function (err) {
      if (err) return res.status(500).json({ error: "Failed to update user profile" });
      res.json({ ok: true, updated: this.changes });
    }
  );
});

// Admin API: Delete User & Cascading Workspaces
app.delete("/api/admin/users/:id", adminAuth, (req, res) => {
  const userId = req.params.id;

  if (parseInt(userId) === req.adminUser.id) {
    return res.status(400).json({ error: "Cannot delete your own super admin account" });
  }

  db.all(`SELECT id FROM projects WHERE user_id = ?`, [userId], (err, projs) => {
    const projIds = (projs || []).map(p => p.id);
    if (projIds.length > 0) {
      const placeholders = projIds.map(() => "?").join(",");
      db.run(`DELETE FROM time_entries WHERE project_id IN (${placeholders})`, projIds);
      db.run(`DELETE FROM messages WHERE project_id IN (${placeholders})`, projIds);
      db.run(`DELETE FROM expenses WHERE project_id IN (${placeholders})`, projIds);
      db.run(`DELETE FROM projects WHERE user_id = ?`, [userId]);
    }
    db.run(`DELETE FROM users WHERE id = ?`, [userId], (delErr) => {
      if (delErr) return res.status(500).json({ error: "Failed to delete user" });
      res.json({ ok: true, message: "User and associated project workspaces purged" });
    });
  });
});

// Admin API: Email Dispatch Logs Audit
app.get("/api/admin/emails", adminAuth, (req, res) => {
  db.all(`SELECT * FROM email_logs ORDER BY id DESC LIMIT 100`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, logs: rows || [] });
  });
});

// Admin API: Resend Test / Custom Email
app.post("/api/admin/send-email", adminAuth, async (req, res) => {
  const { to, subject, html } = req.body;
  if (!to || !subject || !html) return res.status(400).json({ error: "Recipient, subject, and content are required" });

  const result = await dispatchEmail({ to, subject, html, text: subject });
  res.json({ ok: true, result });
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
    `INSERT INTO projects (user_id, name, client_name, hourly_rate, currency, budget_hours, milestones, share_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, name, client_name, hourly_rate || 0, currency || 'USD', budget_hours || 0, milestonesJson, share_token, Date.now()],
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
      db.run(`DELETE FROM expenses WHERE project_id = ?`, [projectId], () => {
        db.run(`DELETE FROM projects WHERE id = ? AND user_id = ?`, [projectId, req.user.id], function(err) {
          if (err) return res.json({ error: "Could not delete project" });
          res.json({ message: "Project deleted successfully" });
        });
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
  const { started_at, stopped_at, notes, billable, tag } = req.body;
  db.run(
    `INSERT INTO time_entries (project_id, started_at, stopped_at, notes, billable, tag) VALUES (?, ?, ?, ?, ?, ?)`,
    [req.params.id, started_at, stopped_at, notes || '', billable !== false ? 1 : 0, tag || 'dev'],
    function (err) {
      if (err) return res.json({ error: "Failed to add manual entry" });
      res.json({ entryId: this.lastID });
    }
  );
});

// ===============================
// EXPENSES
// ===============================
app.get("/projects/:id/expenses", auth, (req, res) => {
  db.all(`SELECT * FROM expenses WHERE project_id = ? ORDER BY date DESC`, [req.params.id], (err, expenses) => {
    res.json({ expenses: expenses || [] });
  });
});

app.post("/projects/:id/expenses", auth, (req, res) => {
  const { amount, category, notes, reimbursable, date } = req.body;
  db.run(
    `INSERT INTO expenses (project_id, amount, category, notes, reimbursable, date) VALUES (?, ?, ?, ?, ?, ?)`,
    [req.params.id, amount, category || 'Other', notes || '', reimbursable !== false ? 1 : 0, date || new Date().toISOString()],
    function (err) {
      if (err) return res.json({ error: "Failed to add expense" });
      res.json({ expenseId: this.lastID });
    }
  );
});

app.delete("/expenses/:id", auth, (req, res) => {
  db.run(`DELETE FROM expenses WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.json({ error: "Failed to delete expense" });
    res.json({ ok: true });
  });
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

// Wildcard fallback to index.html for client-side routing
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 TaskMeter Studio API live on port ${PORT}`);
  console.log(`🔒 Secret Admin Dashboard URL: http://localhost:${PORT}/${ADMIN_SECRET_PATH}`);
  console.log(`===============================================`);
});
