import { App } from "monocdk-experiment";
import { InstanceClass, InstanceSize, InstanceType } from "monocdk-experiment/aws-ec2";
import { Schedule } from "monocdk-experiment/aws-autoscaling";
import { FullStack } from "@fck/cdk";

const app = new App();
const stack = new FullStack(app, "ElectricSoda");

// Instance | vCPU | Mem MiB | Price/Hr (On-Demand)
// m4.large | 2    | 8192    | 0.10
const asg = stack.servers.addSpotCapacity("Capacity", {
  instanceType: InstanceType.of(InstanceClass.M4, InstanceSize.LARGE),
  spotPrice: "0.05",
});

// Scale up the ASG at 6:00PM EST and shut it down at 11:00PM PST
asg.addScheduledActions(Schedule.cron({ hour: "21", minute: "00" }), Schedule.cron({ hour: "6", minute: "00" }));

// A vanilla server on the stable image.
stack.servers.addServer("Vanilla", {
  cpu: 0.5,
  memoryReservationMiB: 2048,
});
