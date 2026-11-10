import { notFound } from "next/navigation";
import Link from "next/link";
import { RemixButton } from "../../../daw/components/RemixButton";
import { API_BASE_URL } from "../../../lib/api";

/**
 * Public project page (ARCHITECTURE §14, screen 2).
 *
 * Implemented as a Next.js Server Component deliberately — this is the one
 * place ARCHITECTURE.md's stack rationale (§3 "SSR for social/discovery
 * pages, SEO for public projects") actually mattered enough to act on: a
 * public project page should be crawlable/shareable without a client-side
 * data fetch waterfall. The DAW workspace itself stays a client component
 * (real-time audio has no business being server-rendered), but this page
 * doesn't need the audio engine at all — just data.
 *
 * The page's whole job, per the product principle, is to make it obvious
 * this is an editable project and not just a song: lineage, credits,
 * version history, and the remix button are all first-class, not
 * afterthoughts below a play button.
 */

interface ProjectDetail {
  id: string;
  title: string;
  description: string | null;
  bpm: number;
  keySignature: string | null;
  visibility: string;
  license: string;
  originType: string | null;
  remixCount: number;
  likeCount: number;
  createdAt: string;
  owner: { username: string; displayName: string; avatarUrl: string | null };
}

interface LineageNode {
  id: string;
  title: string;
  originType: string | null;
  owner?: { username: string; displayName: string } | null;
}

interface VersionEntry {
  id: string;
  message: string;
  createdAt: string;
  diffSummary: unknown;
  author: { username: string; displayName: string };
}

interface CreditEntry {
  id: string;
  role: string;
  user: { username: string; displayName: string };
}

const LICENSE_LABELS: Record<string, string> = {
  no_remix: "No remixing",
  remix_allowed: "Remix allowed",
  remix_with_attribution: "Remix allowed (with attribution)",
  remix_commercial: "Commercial remix allowed",
  cc_by: "CC BY",
  cc_by_sa: "CC BY-SA",
  cc_by_nc: "CC BY-NC",
};

const ORIGIN_VERB: Record<string, string> = {
  fork: "Fork",
  remix: "Remix",
  edit: "Edit",
  bootleg: "Bootleg",
  alt_version: "Alt version",
};

async function fetchJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_BASE_URL}${path}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API error ${res.status} fetching ${path}`);
  return res.json();
}

export default async function ProjectPage({ params }: { params: { projectId: string } }) {
  const project = await fetchJson<ProjectDetail>(`/api/v1/projects/${params.projectId}`);
  if (!project) notFound();

  // These three are independent of each other and of nothing else on the
  // page depending on them existing — fetch in parallel rather than serially.
  const [lineage, versions, credits] = await Promise.all([
    fetchJson<{ ancestors: LineageNode[]; descendants: LineageNode[] }>(`/api/v1/projects/${params.projectId}/lineage`),
    fetchJson<VersionEntry[]>(`/api/v1/projects/${params.projectId}/versions`),
    fetchJson<CreditEntry[]>(`/api/v1/projects/${params.projectId}/credits`),
  ]);

  const directParent = lineage?.ancestors[lineage.ancestors.length - 1];
  const originalAncestor = lineage?.ancestors[0];

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "32px 24px", color: "#eee" }}>
      {/* Lineage strip — shown ABOVE the title, since "what is this derived
          from" is core identity information per the product principle, not
          a footnote. */}
      {directParent && (
        <div style={{ marginBottom: 12, fontSize: 13, color: "#999" }}>
          {ORIGIN_VERB[project.originType ?? ""] ?? "Derived"} of{" "}
          <Link href={`/project/${directParent.id}`} style={{ color: "#7c5cff" }}>
            {directParent.title}
          </Link>
          {directParent.owner && <> by {directParent.owner.displayName}</>}
          {originalAncestor && originalAncestor.id !== directParent.id && (
            <>
              {" "}
              · Originally based on{" "}
              <Link href={`/project/${originalAncestor.id}`} style={{ color: "#7c5cff" }}>
                {originalAncestor.title}
              </Link>
              {originalAncestor.owner && <> by {originalAncestor.owner.displayName}</>}
            </>
          )}
        </div>
      )}

      {/* Hero */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 32 }}>{project.title}</h1>
          <div style={{ color: "#999", marginTop: 6 }}>
            by <strong>{project.owner.displayName}</strong> (@{project.owner.username})
          </div>
          <div style={{ color: "#666", marginTop: 4, fontSize: 13 }}>
            {project.bpm} BPM{project.keySignature ? ` · ${project.keySignature}` : ""} ·{" "}
            {LICENSE_LABELS[project.license] ?? project.license}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
          <RemixButton projectId={project.id} license={project.license} />
          <Link
            href={`/daw/${project.id}`}
            style={{ fontSize: 13, color: "#7c5cff", textDecoration: "none" }}
          >
            Open in DAW →
          </Link>
        </div>
      </div>

      {/* This is an editable project, not a song — said explicitly, per the
          core product principle, rather than only implied by the UI. */}
      <div
        style={{
          marginTop: 20,
          padding: "10px 14px",
          background: "#181c2b",
          border: "1px solid #2a2f45",
          borderRadius: 8,
          fontSize: 13,
          color: "#aab",
        }}
      >
        🎛️ This is an <strong>editable project</strong> — tracks, MIDI, mixer settings, and arrangement, not just an
        audio file. Anyone can remix it into their own version.
      </div>

      {project.description && <p style={{ marginTop: 20, color: "#ccc", lineHeight: 1.6 }}>{project.description}</p>}

      {/* Remix lineage — descendants */}
      {lineage && lineage.descendants.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 16, color: "#aaa" }}>Remixes of this project ({lineage.descendants.length})</h2>
          <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {lineage.descendants.map((d) => (
              <li key={d.id}>
                <Link href={`/project/${d.id}`} style={{ color: "#7c5cff" }}>
                  {d.title}
                </Link>
                {d.owner && <span style={{ color: "#777" }}> by {d.owner.displayName}</span>}
                {d.originType && <span style={{ color: "#555" }}> · {ORIGIN_VERB[d.originType] ?? d.originType}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Credits — automatic attribution, not manually typed */}
      {credits && credits.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 16, color: "#aaa" }}>Credits</h2>
          <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            {credits.map((c) => (
              <li key={c.id} style={{ color: "#ccc", fontSize: 14 }}>
                {c.user.displayName} — <span style={{ color: "#777" }}>{c.role.replace("_", " ")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Version history */}
      {versions && versions.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 16, color: "#aaa" }}>Version history</h2>
          <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {versions.map((v) => (
              <li key={v.id} style={{ borderLeft: "2px solid #333", paddingLeft: 12 }}>
                <div style={{ fontSize: 14, color: "#eee" }}>{v.message}</div>
                <div style={{ fontSize: 12, color: "#777" }}>
                  {v.author.displayName} · {new Date(v.createdAt).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
