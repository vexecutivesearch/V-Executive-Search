export function ListPageSkeleton() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8 animate-pulse">
      <div className="h-8 w-48 bg-gray-200 dark:bg-gray-800 rounded mb-2" />
      <div className="h-4 w-64 bg-gray-100 dark:bg-gray-900 rounded mb-6" />
      <div className="flex gap-2 mb-6">
        <div className="h-8 w-16 bg-gray-100 dark:bg-gray-900 rounded-full" />
        <div className="h-8 w-24 bg-gray-100 dark:bg-gray-900 rounded-full" />
      </div>
      <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-b-0"
          >
            <div className="h-10 w-10 bg-gray-100 dark:bg-gray-900 rounded-lg shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-40 bg-gray-200 dark:bg-gray-800 rounded" />
              <div className="h-3 w-28 bg-gray-100 dark:bg-gray-900 rounded" />
            </div>
            <div className="h-8 w-16 bg-gray-100 dark:bg-gray-900 rounded-md hidden sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function DetailPageSkeleton() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8 animate-pulse">
      <div className="h-4 w-32 bg-gray-100 dark:bg-gray-900 rounded mb-6" />
      <div className="border border-gray-200 dark:border-gray-800 rounded-xl p-6 space-y-4">
        <div className="h-7 w-56 bg-gray-200 dark:bg-gray-800 rounded" />
        <div className="h-4 w-40 bg-gray-100 dark:bg-gray-900 rounded" />
        <div className="h-24 bg-gray-50 dark:bg-gray-900/50 rounded-lg" />
        <div className="h-20 bg-gray-50 dark:bg-gray-900/50 rounded-lg" />
      </div>
    </div>
  );
}
