import { useParams } from "react-router";

/**
 * D-10: new-segment page shell. The condition-tree builder (SegmentBuilder,
 * Task 2) and the name field + save flow (Task 3) are wired in below this
 * header once they exist.
 */
export function SegmentCreatePage() {
  useParams<{ slug: string }>();

  return (
    <div className="space-y-6 p-8">
      <div>
        <h1 className="text-display font-semibold">Создать сегмент</h1>
        <p className="text-sm text-muted-foreground">
          Объедините контакты по свойствам профиля и поведению.
        </p>
      </div>
    </div>
  );
}

export default SegmentCreatePage;
