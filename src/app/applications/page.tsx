import type { Metadata } from "next";
import Link from "next/link";
import { ApplicationList } from "@/components/application-list";
import { ApplicationsIcon, PlusIcon } from "@/components/icons";
import { EmptyState, PageHeader } from "@/components/ui";
import { listApplications } from "@/lib/services";
import { toApplicationView } from "@/app/view-models";

export const metadata: Metadata = { title: "申请" };
export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  const applications = await listApplications({ includeArchived: true });
  return (
    <>
      <PageHeader
        eyebrow="推进全貌"
        title="岗位申请"
        description="按阶段查看所有活跃机会；看板和表格共享当前筛选。阶段可在申请详情中修改。"
        action={<Link className="button button-primary" href="/applications/new"><PlusIcon size={18} />新建申请</Link>}
      />
      {applications.length === 0 ? (
        <div className="section-card">
          <EmptyState icon={<ApplicationsIcon size={26} />} title="还没有岗位申请" description="只需要公司和岗位，就能先建立记录；其他信息可以随后补充。" href="/applications/new" actionLabel="创建第一条申请" />
        </div>
      ) : <ApplicationList applications={applications.map(toApplicationView)} />}
    </>
  );
}
