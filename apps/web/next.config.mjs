/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@gridflex/contracts', '@gridflex/engine'],
};
export default nextConfig;
