import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/sonner";

/**
 * Wave-0 scaffold: router + TanStack Query provider only. Auth pages land
 * in Task 2, the create-workspace/app-shell/home routes in Task 3.
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={null} />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </QueryClientProvider>
  );
}
