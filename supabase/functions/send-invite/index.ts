// Deploy: supabase functions deploy send-invite
// Secrets needed: RESEND_API_KEY (required), RESEND_FROM (optional, e.g. "Foci <invites@yourdomain.com>")
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided automatically by the Supabase runtime.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_URL = "https://foci-std.vercel.app/app.html";
const LIME = "#c8ff2e";
const INK = "#111111";

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function emailHtml(inviterEmail: string, projectTitle: string, link: string) {
  const inv = escapeHtml(inviterEmail), title = escapeHtml(projectTitle);
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#e9e4da;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9e4da;padding:32px 0;">
<tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:20px;overflow:hidden;max-width:480px;width:100%;">
<tr><td style="background:${INK};padding:28px 32px;">
<span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:3px solid ${LIME};vertical-align:middle;margin-right:8px;"></span>
<span style="color:#ffffff;font-size:18px;font-weight:600;letter-spacing:.04em;vertical-align:middle;">FOCI</span>
</td></tr>
<tr><td style="padding:32px;color:${INK};">
<p style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#888;margin:0 0 16px;">Project invite</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 24px;">
${inv} sent you a request to work on the project "<strong>${title}</strong>". You can access it from this link:
</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
<tr><td style="background:${INK};border-radius:24px;">
<a href="${link}" style="display:inline-block;padding:14px 28px;color:${LIME};font-size:14px;font-weight:600;text-decoration:none;border-radius:24px;">Open Foci</a>
</td></tr>
</table>
<hr style="border:none;border-top:1px solid #eee;margin:0 0 24px;">
<p style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#888;margin:0 0 16px;">Invitation au projet</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 24px;">
${inv} t'a envoyé une demande pour travailler sur le projet « <strong>${title}</strong> ». Tu peux y accéder depuis ce lien :
</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0;">
<tr><td style="background:${INK};border-radius:24px;">
<a href="${link}" style="display:inline-block;padding:14px 28px;color:${LIME};font-size:14px;font-weight:600;text-decoration:none;border-radius:24px;">Ouvrir Foci</a>
</td></tr>
</table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const { token } = await req.json();
    if (!token) return new Response(JSON.stringify({ error: "Missing token" }), { status: 400 });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: member, error: memberErr } = await admin
      .from("project_members")
      .select("email, project_id, projects(title, owner_id)")
      .eq("token", token)
      .maybeSingle();

    if (memberErr || !member) {
      return new Response(JSON.stringify({ error: "Invite not found" }), { status: 404 });
    }

    const project = Array.isArray(member.projects) ? member.projects[0] : member.projects;
    const { data: ownerUser } = await admin.auth.admin.getUserById(project.owner_id);
    const inviterEmail = ownerUser?.user?.email || "A Foci user";

    const link = `${APP_URL}?invite=${token}`;
    const html = emailHtml(inviterEmail, project.title, link);

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) return new Response(JSON.stringify({ error: "RESEND_API_KEY not set" }), { status: 500 });
    const from = Deno.env.get("RESEND_FROM") || "Foci <onboarding@resend.dev>";

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [member.email],
        subject: `${inviterEmail} invited you to a project on Foci`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      return new Response(JSON.stringify({ error: "Resend failed", detail: errText }), { status: 502 });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
