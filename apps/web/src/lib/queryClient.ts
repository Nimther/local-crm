import { QueryClient } from "@tanstack/react-query";

/** Single TanStack Query client for all server state (workspaces, membership, etc.). */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
