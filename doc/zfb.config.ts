import { defineConfig } from "zfb/config";
import { zudoDoc } from "@takazudo/zudo-doc/config";

export default defineConfig(
  zudoDoc({
    themePack: "drift",
    siteName: "zudo-ez-host",
    siteDescription:
      "Architecture and product specifications for the zudo-ez-host static-site publishing service.",
    githubUrl: "https://github.com/zudolab/zudo-ez-host",
    locales: {
      ja: {
        label: "JA",
        dir: "src/content/docs-ja",
      },
    },
    metaTags: {
      description: true,
      keywords: "",
      // Add a social-card asset before enabling this; the preset path does not
      // exist in the generated scaffold and would emit a broken og:image URL.
      ogImage: false,
      ogSiteName: true,
      twitterCard: false,
    },
    llmsTxt: true,
    cjkFriendly: true,
    sidebarResizer: true,
    sidebarToggle: true,
    tocToggle: true,
    imageEnlarge: true,
    dynamicPageTransition: true,
    docHistory: true,
    claudeResources: {
      claudeDir: "../.claude",
      // Keep generated pages under doc/ while scanning the repository root.
      projectRoot: ".",
      scanRoot: "..",
    },
    defaultLocaleOnlyPrefixes: [
      "/docs/claude-md/",
      "/docs/claude-skills/",
      "/docs/claude-agents/",
      "/docs/claude-commands/",
    ],
    footer: {
      links: [],
      copyright: "Copyright © 2026 zudo-ez-host contributors. Built with zudo-doc.",
    },
    headerNav: [
      {
        label: "Getting Started",
        path: "/docs/getting-started",
        categoryMatch: "getting-started",
      },
      {
        label: "Concepts",
        path: "/docs/concepts",
        categoryMatch: "concepts",
      },
      {
        label: "Hosting",
        path: "/docs/hosting",
        categoryMatch: "hosting",
      },
      {
        label: "Sync",
        path: "/docs/sync",
        categoryMatch: "sync",
      },
      {
        label: "Webapp",
        path: "/docs/webapp",
        categoryMatch: "webapp",
      },
    ],
    headerRightItems: [
      {
        type: "component",
        component: "github-link",
      },
      {
        type: "component",
        component: "theme-toggle",
      },
      {
        type: "component",
        component: "search",
      },
      {
        type: "component",
        component: "language-switcher",
      },
    ],
  }),
);
