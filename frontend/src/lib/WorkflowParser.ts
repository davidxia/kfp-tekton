/*
 * Copyright 2018-2019 The Kubeflow Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as dagre from 'dagre';
import { NodeStatus, Parameter, S3Artifact, Workflow } from '../third_party/mlmd/argo_template';
import { statusToIcon } from '../pages/Status';
import { Constants } from './Constants';
import { parseTaskDisplayName } from './ParserUtils';
import { KeyValue } from './StaticGraphParser';
import { NodePhase, statusToBgColor, statusToPhase } from './StatusUtils';
import { Execution } from 'src/third_party/mlmd/generated/ml_metadata/proto/metadata_store_pb';
import { isV2Pipeline } from './v2/WorkflowUtils';
import { ExecutionHelpers } from 'src/mlmd/MlmdUtils';

export enum StorageService {
  GCS = 'gcs',
  HTTP = 'http',
  HTTPS = 'https',
  MINIO = 'minio',
  S3 = 's3',
  VOLUME = 'volume',
}

export interface StoragePath {
  source: StorageService;
  bucket: string;
  key: string;
}

// Adjusted for use with Tekton Backend
export default class WorkflowParser {
  public static createRuntimeGraph(
    workflow: any,
    executions: Execution[] | undefined,
  ): dagre.graphlib.Graph {
    const nodeStateMap = buildNodeToExecutionStateMap(executions);
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({});
    graph.setDefaultEdgeLabel(() => ({}));

    // If a run exists but no status is available yet return an empty graph
    if (
      workflow &&
      workflow.status &&
      (Object.keys(workflow.status).length === 0 || !workflow.status.taskRuns)
    )
      return graph;

    const tasks = (workflow['spec']['pipelineSpec']['tasks'] || []).concat(
      workflow['spec']['pipelineSpec']['finally'] || [],
    );
    const status = workflow['status']['taskRuns'];
    const skippedTasks: string[] = (workflow['status']['skippedTasks'] || []).map(
      (obj: any) => obj.name,
    );
    const pipelineParams = workflow['spec']['params'] || [];
    const exitHandlers =
      (workflow['spec']['pipelineSpec']['finally'] || []).map((element: any) => {
        return element['name'];
      }) || [];

    // Create a map from task name to status for every status received
    const statusMap = new Map<string, any>();
    for (const taskRunId of Object.getOwnPropertyNames(status || {})) {
      status[taskRunId]['taskRunId'] = taskRunId;
      if (status[taskRunId]['status'])
        statusMap.set(status[taskRunId]['pipelineTaskName'], status[taskRunId]);
    }

    // Add custom tasks to the status map
    for (const taskRunId of Object.getOwnPropertyNames(workflow['status']['runs'] || {})) {
      workflow['status']['runs'][taskRunId]['taskRunId'] = taskRunId;
      if (workflow['status']['runs'][taskRunId]['status'])
        statusMap.set(
          workflow['status']['runs'][taskRunId]['pipelineTaskName'],
          workflow['status']['runs'][taskRunId],
        );
    }

    // Add When-condition tasks to conditionTasks list if it depends on the result of the tasks in statusMap
    const conditionTasks: String[] = [];
    for (const task of tasks) {
      if (!statusMap.get(task['name'])) {
        for (const condition of task['when'] || []) {
          const param = this.decodeParam(condition['input']);
          if (param && param.task) {
            if (statusMap.get(param.task)) {
              conditionTasks.push(task['name']);
              break;
            }
          }
        }
      }
    }

    for (const task of tasks) {
      // If the task has a status then add it and its edges to the graph
      if (statusMap.get(task['name']) || conditionTasks.includes(task['name'])) {
        const conditions = task['conditions'] || [];
        const taskId =
          statusMap.get(task['name']) &&
          statusMap.get(task['name'])!['status']['podName'] !== '' &&
          statusMap.get(task['name'])!['status']['podName'] !== undefined
            ? statusMap.get(task['name'])!['status']['podName']
            : task['name'];
        const edges = this.checkParams(statusMap, pipelineParams, task, '');

        // Add all of this Task's conditional dependencies as Task dependencies
        for (const condition of conditions)
          edges.push(...this.checkParams(statusMap, pipelineParams, condition, taskId));

        // Add all of this Task's conditional dependencies as Task dependencies
        for (const condition of task['when'] || []) {
          const param = this.decodeParam(condition['input']);
          if (param && param.task) {
            if (statusMap.get(param.task)) {
              const parentId =
                statusMap.get(param.task)!['status']['podName'] ||
                statusMap.get(param.task)!['pipelineTaskName'];
              edges.push({ parent: parentId, child: taskId });
            }
          }
        }

        // Checks if the task is an any-sequencer and if so, adds the dependencies from the task list
        if (
          task['taskSpec'] &&
          task['taskSpec']['steps'] &&
          task['taskSpec']['steps'][0] &&
          task['taskSpec']['steps'][0]['args'] &&
          task['taskSpec']['steps'][0]['command'] &&
          task['taskSpec']['steps'][0]['command'][0] &&
          task['taskSpec']['steps'][0]['command'][0] === 'any-task'
        ) {
          let isNextTaskList = false;
          let isNextCondition = false;
          task['taskSpec']['steps'][0]['args'].forEach((arg: string) => {
            if (arg === '--taskList') {
              isNextTaskList = true;
            } else if (arg === '-c') {
              isNextCondition = true;
            } else if (isNextTaskList) {
              arg.split(',').forEach((parentTask: string) => {
                if (statusMap.get(parentTask)) {
                  const parentId =
                    statusMap.get(parentTask)['status']['podName'] ||
                    statusMap.get(parentTask)['pipelineTaskName'];
                  graph.setEdge(parentId, taskId);
                }
              });
              isNextTaskList = false;
            } else if (isNextCondition) {
              const parentTask = arg.substring(arg.indexOf('results_') + 8, arg.indexOf('_output'));
              if (statusMap.get(parentTask)) {
                const parentId =
                  statusMap.get(parentTask)['status']['podName'] ||
                  statusMap.get(parentTask)['pipelineTaskName'];
                graph.setEdge(parentId, taskId);
              }
              isNextCondition = false;
            }
          });
        }

        if (task['runAfter']) {
          task['runAfter'].forEach((parentTask: any) => {
            if (
              statusMap.get(parentTask) &&
              statusMap.get(parentTask)!['status']['conditions'][0]['type'] === 'Succeeded'
            ) {
              const parentId = statusMap.get(parentTask)!['status']['podName'];
              edges.push({ parent: parentId, child: taskId });
            }
          });
        }
        for (const edge of edges || []) graph.setEdge(edge['parent'], edge['child']);

        let status = NodePhase.PENDING;
        if (!conditionTasks.includes(task['name'])) {
          status = this.getStatus(statusMap.get(task['name']));
        } else if (skippedTasks.includes(task['name'])) {
          status = NodePhase.CONDITIONCHECKFAILED;
        }

        const phase = statusToPhase(status);
        const statusColoring = exitHandlers.includes(task['name'])
          ? '#fef7f0'
          : statusToBgColor(phase, '');
        let mlmdState: Execution.State | undefined;
        if (isV2Pipeline(workflow)) {
          mlmdState = nodeStateMap.get(taskId);
        }
        const taskStatusJson = statusMap.get(task['name']) || {status: {startTime:"", completionTime: ""}}
        // Add a node for the Task
        graph.setNode(taskId, {
          height: Constants.NODE_HEIGHT,
          icon: statusToIcon(status,taskStatusJson["status"]["startTime"], taskStatusJson["status"]["completionTime"], "", mlmdState),
          label: parseTaskDisplayName(task['taskSpec'] || task['taskRef']) || task['name'],
          statusColoring: statusColoring,
          width: Constants.NODE_WIDTH,
        });
      }
    }

    return graph;
  }

  private static checkParams(
    statusMap: Map<string, any>,
    pipelineParams: any,
    component: any,
    ownerTask: string,
  ): { parent: string; child: string }[] {
    const edges: { parent: string; child: string }[] = [];
    const componentId =
      ownerTask !== ''
        ? component['conditionRef']
        : statusMap.get(component['name']) &&
          statusMap.get(component['name'])!['status']['podName'] !== '' &&
          statusMap.get(component['name'])!['status']['podName'] !== undefined
        ? statusMap.get(component['name'])!['status']['podName']
        : component['name'];

    // Adds dependencies from task params
    for (const param of component['params'] || []) {
      let paramValue = param['value'] || '';

      const splitParam = this.decodeParam(param['value']);

      // If the parameters are passed from the pipeline parameters then grab the value from the pipeline parameters
      if (splitParam && !splitParam.task) {
        for (const pipelineParam of pipelineParams)
          if (pipelineParam['name'] === splitParam.param) paramValue = pipelineParam['value'];
      }
      // If the parameters are passed from the parent task's results and the task is completed then grab the resulting values
      else if (splitParam && splitParam.task) {
        const parentTask = splitParam.task;
        const paramName = splitParam.param;
        if (
          statusMap.get(parentTask) &&
          statusMap.get(parentTask)['status']['conditions'] &&
          statusMap.get(parentTask)['status']['conditions'][0]['type'] === 'Succeeded'
        ) {
          const parentId = statusMap.get(parentTask)!['status']['podName'];
          edges.push({ parent: parentId, child: ownerTask === '' ? componentId : ownerTask });

          // Add the taskResults value to the params value in status
          for (const result of statusMap.get(parentTask)!['status']['taskResults'] || []) {
            if (result['name'] === paramName) paramValue = result['value'];
          }
        }
      }
      // Find the output that matches this input and pull the value
      if (
        statusMap.get(component['name']) &&
        statusMap.get(component['name'])['status']['taskSpec']
      ) {
        for (const statusParam of statusMap.get(component['name'])!['status']['taskSpec']['params'])
          if (statusParam['name'] === param['name']) statusParam['value'] = paramValue;
      }
    }

    return edges;
  }

  private static decodeParam(paramString: string) {
    // If the parameters are passed from the pipeline parameters
    if (
      paramString.substring(0, 9) === '$(params.' &&
      paramString.substring(paramString.length - 1) === ')'
    ) {
      const paramName = paramString.substring(9, paramString.length - 1);
      return { task: '', param: paramName };
    }
    // If the parameters are passed from the parent task's results
    else if (paramString.indexOf('$(') !== -1 && paramString.indexOf(')') !== -1) {
      const paramSplit = paramString.split('.');
      const parentTask = paramSplit[1];
      const paramName = paramSplit[paramSplit.length - 1].substring(
        0,
        paramSplit[paramSplit.length - 1].length - 1,
      );

      return { task: parentTask, param: paramName };
    }
    return {};
  }

  public static getStatus(execStatus: any): NodePhase {
    if (execStatus && execStatus.status && execStatus.status.conditions) {
      return execStatus!.status!.conditions![0].reason;
    }
    return NodePhase.PENDING;
  }

  public static getParameters(workflow?: any): Parameter[] {
    if (workflow && workflow.spec && workflow.spec.params) {
      return workflow.spec.params || [];
    }

    return [];
  }

  public static getTaskRunStatusFromPodName(workflow: any, podName: string) {
    for (const taskRunId of Object.getOwnPropertyNames(workflow.status.taskRuns || {})) {
      const taskRun = workflow.status.taskRuns[taskRunId];
      if (taskRun.status && taskRun.status.podName === podName) {
        return taskRun;
      }
    }
  }

  // Makes sure the workflow object contains the node and returns its
  // inputs/outputs if any, while looking out for any missing link in the chain to
  // the node's inputs/outputs.
  public static getNodeInputOutputParams(
    workflow?: any,
    nodeId?: string,
  ): Record<'inputParams' | 'outputParams', Array<KeyValue<string>>> {
    type ParamList = Array<KeyValue<string>>;
    let inputParams: ParamList = [];
    let outputParams: ParamList = [];
    if (!nodeId || !workflow || !workflow.status || !workflow.status.taskRuns) {
      return { inputParams, outputParams };
    }

    for (const taskRunId of Object.getOwnPropertyNames(workflow.status.taskRuns || {})) {
      const taskRun = workflow.status.taskRuns[taskRunId];
      if (taskRun.status && taskRun.status.podName === nodeId) {
        inputParams = taskRun.status.taskSpec.params
          ? taskRun.status.taskSpec.params.map(({ name, value }: any) => [name, value])
          : inputParams;
        outputParams = taskRun.status.taskResults
          ? taskRun.status.taskResults.map(({ name, value }: any) => [name, value])
          : outputParams;
      }
    }

    // Loop for custom tasks
    for (const runId of Object.getOwnPropertyNames(workflow.status.runs || {})) {
      const run = workflow.status.runs[runId];
      if (run.status && run.pipelineTaskName === nodeId) {
        outputParams = run.status.results
          ? run.status.results.map(({ name, value }: any) => [name, value])
          : outputParams;
      }
    }

    return { inputParams, outputParams };
  }

  // Makes sure the workflow object contains the node and returns its
  // inputs/outputs artifacts if any, while looking out for any missing link in the chain to
  // the node's inputs/outputs.
  public static getNodeInputOutputArtifacts(
    workflow?: any,
    nodeId?: string,
    cachedPipelineRun?: string,
  ): Record<'inputArtifacts' | 'outputArtifacts', Array<KeyValue<S3Artifact>>> {
    type ParamList = Array<KeyValue<S3Artifact>>;
    let inputArtifacts: ParamList = [];
    let outputArtifacts: ParamList = [];

    if (
      !workflow ||
      !workflow.metadata ||
      !workflow.status ||
      !(workflow.status.taskRuns || workflow.status.runs) ||
      !workflow.metadata.annotations
    )
      return { inputArtifacts, outputArtifacts };

    // Get the task name that corresponds to the nodeId
    let taskName = '';
    let taskStatus: NodePhase = NodePhase.SUCCEEDED;
    for (const taskRunId of Object.getOwnPropertyNames(workflow.status.taskRuns || {})) {
      const taskRun = workflow.status.taskRuns[taskRunId];
      if (taskRun.status && taskRun.status.podName === nodeId) {
        taskName = taskRun.pipelineTaskName;
        taskStatus = this.getStatus(taskRun);
      }
    }

    // Loop for custom tasks
    for (const runId of Object.getOwnPropertyNames(workflow.status.runs || {})) {
      const run = workflow.status.runs[runId];
      if (run.status && run.pipelineTaskName === nodeId) {
        taskName = run.pipelineTaskName
        taskStatus = this.getStatus(run);
      }
    }

    if (!taskName) return { inputArtifacts, outputArtifacts };

    const annotations = workflow.metadata.annotations;
    const rawInputArtifacts = annotations['tekton.dev/input_artifacts']
      ? JSON.parse(annotations['tekton.dev/input_artifacts'])
      : [];
    const rawOutputArtifacts = annotations['tekton.dev/output_artifacts']
      ? JSON.parse(annotations['tekton.dev/output_artifacts'])
      : [];

    let template = {
      endpoint: annotations['tekton.dev/artifact_endpoint'],
      bucket: annotations['tekton.dev/artifact_bucket'],
      insecure: annotations['tekton.dev/artifact_endpoint_scheme'] === 'http://',
      accessKeySecret: { name: 'mlpipeline-minio-artifact', key: 'accesskey', optional: false },
      secretKeySecret: { name: 'mlpipeline-minio-artifact', key: 'secretkey', optional: false },
      key: `artifacts/${workflow.metadata.name || ''}`,
    };

    inputArtifacts = (rawInputArtifacts[taskName] || []).map((artifact: any) => {
      const parentTask = artifact.parent_task;
      let pipelineRunID = workflow.metadata.name || '';
      // Use the cached pipelineRun as the pipelineRunID if this artifact is stored by a taskRun with caching enabled
      workflow.spec.pipelineSpec.tasks.forEach((task: any) => {
        if (
          parentTask === task.name &&
          ((((task.taskSpec||{}).metadata||{}).labels||{})['pipelines.kubeflow.org/cache_enabled']||'false') === 'true' &&
          cachedPipelineRun
        )
          pipelineRunID = cachedPipelineRun;
      });
      return [
        artifact.name,
        {
          endpoint: template.endpoint,
          bucket: template.bucket,
          insecure: template.insecure,
          accessKeySecret: template.accessKeySecret,
          secretKeySecret: template.secretKeySecret,
          key: `artifacts/${pipelineRunID}/${parentTask}/${artifact.name.substring(
            artifact.parent_task.length + 1,
          )}.tgz`,
        },
      ];
    });

    // If no key exists in artifact annotations then return no output artifacts (for backwards compatibility)
    // If the task has not completed successfully then the output artifacts do not exist yet
    if (
      !rawOutputArtifacts[taskName] ||
      !rawOutputArtifacts[taskName][0] ||
      !rawOutputArtifacts[taskName][0].key ||
      (taskStatus !== NodePhase.COMPLETED && taskStatus !== NodePhase.SUCCEEDED)
    )
      return { inputArtifacts, outputArtifacts };

    outputArtifacts = rawOutputArtifacts[taskName].map((artifact: any) => {
      const split = artifact.key.split('/');
      const taskName = split[2];
      let pipelineRunID = workflow.metadata.name || '';
      // Use the cached pipelineRun as the pipelineRunID if this artifact is stored by a taskRun with caching enabled
      workflow.spec.pipelineSpec.tasks.forEach((task: any) => {
        if (
          taskName === task.name &&
          ((((task.taskSpec||{}).metadata||{}).labels||{})['pipelines.kubeflow.org/cache_enabled']||'false') === 'true' &&
          cachedPipelineRun
        )
          pipelineRunID = cachedPipelineRun;
      });
      return [
        artifact.name,
        {
          endpoint: template.endpoint,
          bucket: template.bucket,
          insecure: template.insecure,
          accessKeySecret: template.accessKeySecret,
          secretKeySecret: template.secretKeySecret,
          key: artifact.key.replace('$PIPELINERUN', pipelineRunID),
        },
      ];
    });

    return { inputArtifacts, outputArtifacts };
  }

  // Makes sure the workflow object contains the node and returns its
  // volume mounts if any.
  public static getNodeVolumeMounts(workflow: any, nodeId: string): Array<KeyValue<string>> {
    if (!workflow || !workflow.status || !workflow.status.taskRuns) {
      return [];
    }

    // If the matching taskRun for nodeId can be found then return the volumes found in the main step
    for (const task of Object.getOwnPropertyNames(workflow.status.taskRuns || {})) {
      const taskRun = workflow.status.taskRuns[task];
      if (taskRun.status && taskRun.status.podName === nodeId) {
        const steps = workflow.status.taskRuns[task].status.taskSpec.steps;
        for (const step of steps || [])
          if (step.name === 'main')
            return (step.volumeMounts || []).map((volume: any) => [volume.mountPath, volume.name]);
      }
    }
    return [];
  }

  // Makes sure the workflow object contains the node and returns its
  // action and manifest.
  public static getNodeManifest(workflow: Workflow, nodeId: string): Array<KeyValue<string>> {
    if (
      !workflow ||
      !workflow.status ||
      !workflow.status.nodes ||
      !workflow.status.nodes[nodeId] ||
      !workflow.spec ||
      !workflow.spec.templates
    ) {
      return [];
    }

    const node = workflow.status.nodes[nodeId];
    const tmpl = workflow.spec.templates.find(t => !!t && !!t.name && t.name === node.templateName);
    let manifest: Array<KeyValue<string>> = [];
    if (tmpl && tmpl.resource && tmpl.resource.action && tmpl.resource.manifest) {
      manifest = [[tmpl.resource.action, tmpl.resource.manifest]];
    }
    return manifest;
  }

  // Returns a list of output paths for the given workflow Node, by looking for
  // and the Argo artifacts syntax in the outputs section.
  public static loadNodeOutputPaths(selectedWorkflowNode: any, workflow: any): StoragePath[] {
    const outputPaths: StoragePath[] = [];

    if (
      !workflow ||
      !workflow.metadata ||
      !workflow.metadata.annotations ||
      !workflow.metadata.name
    )
      return outputPaths;

    const annotations = workflow.metadata.annotations;
    const artifacts = annotations['tekton.dev/output_artifacts']
      ? JSON.parse(annotations['tekton.dev/output_artifacts'])[
          selectedWorkflowNode.pipelineTaskName
        ]
      : [];
    const bucket = annotations['tekton.dev/artifact_bucket'] || '';
    const source = annotations['tekton.dev/artifact_endpoint'] || '';

    if (artifacts) {
      (artifacts || [])
        .filter((a: any) => a.name === 'mlpipeline-ui-metadata')
        .forEach((a: any) => {
          // Check that key exists (for backwards compatibility)
          if (a.key)
            outputPaths.push({
              bucket: bucket,
              key: a.key.replace('$PIPELINERUN', workflow.metadata.name || ''),
              source: source.indexOf('minio') !== -1 ? StorageService.MINIO : StorageService.S3,
            });
        });
    }
    return outputPaths;
  }

  // Returns a list of output paths for the entire workflow, by searching all nodes in
  // the workflow, and parsing outputs for each.
  public static loadAllOutputPaths(workflow: Workflow): StoragePath[] {
    return this.loadAllOutputPathsWithStepNames(workflow).map(entry => entry.path);
  }

  // Returns a list of object mapping a step name to output path for the entire workflow,
  // by searching all nodes in the workflow, and parsing outputs for each.
  public static loadAllOutputPathsWithStepNames(
    workflow: any,
  ): Array<{ stepName: string; path: StoragePath }> {
    const outputPaths: Array<{ stepName: string; path: StoragePath }> = [];

    if (workflow && workflow.status && workflow.status.taskRuns) {
      Object.keys(workflow.status.taskRuns).forEach(n => {
        this.loadNodeOutputPaths(workflow.status.taskRuns[n], workflow).map(path =>
          outputPaths.push({ stepName: workflow.status.taskRuns[n].pipelineTaskName, path }),
        );
      });
    }

    return outputPaths;
  }

  // Given a storage path, returns a structured object that contains the storage
  // service (currently only GCS), and bucket and key in that service.
  public static parseStoragePath(strPath: string): StoragePath {
    if (strPath.startsWith('gs://')) {
      const pathParts = strPath.substr('gs://'.length).split('/');
      return {
        bucket: pathParts[0],
        key: pathParts.slice(1).join('/'),
        source: StorageService.GCS,
      };
    } else if (strPath.startsWith('minio://')) {
      const pathParts = strPath.substr('minio://'.length).split('/');
      return {
        bucket: pathParts[0],
        key: pathParts.slice(1).join('/'),
        source: StorageService.MINIO,
      };
    } else if (strPath.startsWith('s3://')) {
      const pathParts = strPath.substr('s3://'.length).split('/');
      return {
        bucket: pathParts[0],
        key: pathParts.slice(1).join('/'),
        source: StorageService.S3,
      };
    } else if (strPath.startsWith('http://')) {
      const pathParts = strPath.substr('http://'.length).split('/');
      return {
        bucket: pathParts[0],
        key: pathParts.slice(1).join('/'),
        source: StorageService.HTTP,
      };
    } else if (strPath.startsWith('https://')) {
      const pathParts = strPath.substr('https://'.length).split('/');
      return {
        bucket: pathParts[0],
        key: pathParts.slice(1).join('/'),
        source: StorageService.HTTPS,
      };
    } else if (strPath.startsWith('volume://')) {
      const pathParts = strPath.substr('volume://'.length).split('/');
      return {
        bucket: pathParts[0],
        key: pathParts.slice(1).join('/'),
        source: StorageService.VOLUME,
      };
    } else {
      throw new Error('Unsupported storage path: ' + strPath);
    }
  }

  // Outbound nodes are roughly those nodes which are the final step of the
  // workflow's execution. More information can be found in the NodeStatus
  // interface definition.
  public static getOutboundNodes(graph: Workflow, nodeId: string): string[] {
    let outbound: string[] = [];

    if (!graph || !graph.status || !graph.status.nodes) {
      return outbound;
    }

    const node = graph.status.nodes[nodeId];
    if (!node) {
      return outbound;
    }

    if (node.type === 'Pod') {
      return [node.id];
    }
    for (const outboundNodeID of node.outboundNodes || []) {
      const outNode = graph.status.nodes[outboundNodeID];
      if (outNode && outNode.type === 'Pod') {
        outbound.push(outboundNodeID);
      } else {
        outbound = outbound.concat(this.getOutboundNodes(graph, outboundNodeID));
      }
    }
    return outbound;
  }

  // Returns whether or not the given node is one of the intermediate nodes used
  // by Argo to orchestrate the workflow. Such nodes are not generally
  // meaningful from a user's perspective.
  public static isVirtual(node: NodeStatus): boolean {
    return (
      (node.type === 'StepGroup' ||
        node.type === 'DAG' ||
        node.type === 'TaskGroup' ||
        node.type === 'Retry') &&
      !!node.boundaryID
    );
  }

  // Returns a workflow-level error string if found, empty string if none
  public static getWorkflowError(workflow: Workflow): string {
    if (
      workflow &&
      workflow.status &&
      workflow.status.message &&
      (workflow.status.phase === NodePhase.ERROR || workflow.status.phase === NodePhase.FAILED)
    ) {
      return workflow.status.message;
    } else {
      return '';
    }
  }
}

function buildNodeToExecutionStateMap(
  executions: Execution[] | undefined,
): Map<string, Execution.State> {
  const m = new Map<string, Execution.State>();
  executions?.forEach(execution => {
    const podname = ExecutionHelpers.getKfpPod(execution);
    if (typeof podname === 'string') {
      m.set(podname, execution.getLastKnownState());
    }
  });
  return m;
}
