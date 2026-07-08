export default function RootPage() {
  return (
    <html lang="en">
      <head>
        {/* Redirect human visitors to the English landing page. The full SEO
            metadata below keeps the root URL useful to crawlers and link
            previews; /en/ is the canonical document (see <link canonical>). */}
        <meta httpEquiv="refresh" content="0; url=./en/" />
        <title>taskflow — Declarative DAG Orchestration for Coding Agents</title>
        <meta
          name="description"
          content="A declarative, verifiable graph of task nodes for coding-agent subagents. Fan out, gate, loop, resume, and save as a command."
        />
        <link rel="canonical" href="https://heggria.github.io/taskflow/en/" />
        <meta
          property="og:title"
          content="taskflow — Declarative DAG Orchestration for Coding Agents"
        />
        <meta
          property="og:description"
          content="A declarative, verifiable graph of task nodes for coding-agent subagents. Fan out, gate, loop, resume, and save as a command."
        />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://heggria.github.io/taskflow/en/" />
        <meta
          property="og:image"
          content="https://heggria.github.io/taskflow/opengraph-image"
        />
        <meta name="twitter:card" content="summary_large_image" />
        <meta
          name="twitter:title"
          content="taskflow — Declarative DAG Orchestration for Coding Agents"
        />
        <meta
          name="twitter:description"
          content="A declarative, verifiable graph of task nodes for coding-agent subagents. Fan out, gate, loop, resume, and save as a command."
        />
        <meta
          name="twitter:image"
          content="https://heggria.github.io/taskflow/opengraph-image"
        />
        <meta
          name="google-site-verification"
          content="iBm6KBJfiBJLOmW6jAtJCJlCbTiP7W9PhrDW6afMltw"
        />
      </head>
      <body />
    </html>
  );
}
