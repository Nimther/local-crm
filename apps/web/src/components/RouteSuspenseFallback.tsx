import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level Suspense fallback (OPS-16, D-14): every lazily-loaded feature
 * route renders this while its chunk is in flight, so a route in transit
 * looks like the page it is becoming (Card/Skeleton composition, matching
 * the idiom already used by e.g. ContactsListPage's own loading state)
 * rather than a blank screen. Presentational only -- no data fetching, no
 * router hooks.
 */
export function RouteSuspenseFallback() {
  return (
    <div className="space-y-6 p-8">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

export default RouteSuspenseFallback;
