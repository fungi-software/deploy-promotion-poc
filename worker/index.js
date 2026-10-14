// Stand-in for the routing worker; a change here needs worker_order on a production promotion.
export default { fetch: () => new Response("ok") };
