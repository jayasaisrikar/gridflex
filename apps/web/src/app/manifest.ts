import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'GridFlex — Flexibility Assurance',
    short_name: 'GridFlex',
    description:
      'Facility flexibility assurance with traceable telemetry, constraints, drills, and evidence.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0B111C',
    theme_color: '#061F40',
    icons: [
      {
        src: '/icons/gridflex-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icons/gridflex-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  };
}
