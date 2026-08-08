export const prerender = false;
export function load({ params }: { params: { entity: string } }) {
  return params;
}
