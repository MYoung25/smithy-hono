// @ts-check
// Docusaurus v3 classic config for the smithy-hono documentation site.
// Docs-only (no blog). The content root is the repo's existing `../docs`
// directory, so `docs/` stays the single source of truth. A custom landing
// page (src/pages/index.js) owns `/`; docs live under `/docs`.

const { themes: prismThemes } = require('prism-react-renderer');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'smithy-hono',
  tagline:
    'Generate a secure, deployable Hono API server (routes, Zod, errors, SSE, MCP) from a Smithy model',
  favicon: 'img/favicon.svg',

  // Published to Cloudflare Pages at the apex domain, so the site lives at the
  // root: url = the canonical origin, baseUrl = '/'.
  url: 'https://smithy-hono.com',
  baseUrl: '/',

  onBrokenLinks: 'throw',

  // `detect`: plain `.md` parse as CommonMark (so bare `<...>` / `{...}` in
  // prose don't choke MDX), while `.mdx` files still parse as MDX.
  markdown: {
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: '../docs',
          // Docs are served under `/docs`; the custom homepage owns `/`.
          routeBasePath: '/docs',
          sidebarPath: require.resolve('./sidebars.js'),
          // No editUrl: the source repo is private and must not be linked publicly.
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/social-card.png',
      metadata: [
        {
          name: 'description',
          content:
            'smithy-hono generates a secure, deployable Hono API server — routes, Zod validation, typed errors, SSE, and MCP — from a Smithy model.',
        },
        { name: 'keywords', content: 'smithy, hono, codegen, api, typescript, cloudflare, mcp' },
      ],
      colorMode: {
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: 'smithy-hono',
        logo: {
          alt: 'smithy-hono logo',
          src: 'img/logo.svg',
        },
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docs',
            position: 'left',
            label: 'Docs',
          },
          {
            to: '/docs/getting-started/quickstart',
            label: 'Quickstart',
            position: 'left',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Introduction', to: '/docs/' },
              { label: 'Getting started', to: '/docs/getting-started/' },
              { label: 'Consuming', to: '/docs/consuming/' },
            ],
          },
          {
            title: 'Reference',
            items: [
              { label: 'Packages', to: '/docs/reference/packages' },
              { label: 'Deployment targets', to: '/docs/reference/deployment-targets' },
              { label: 'Security', to: '/docs/consuming/security' },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} smithy-hono.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['bash', 'json', 'kotlin', 'java'],
      },
    }),
};

module.exports = config;
