$version: "2.0"
namespace com.test

service TreeService {
    version: "1.0"
    operations: [GetTree]
}

@http(method: "GET", uri: "/tree/{id}", code: 200)
@optionalAuth
operation GetTree {
    input: GetTreeInput
    output: GetTreeOutput
}

structure GetTreeInput {
    @httpLabel
    @required
    id: String
}

structure GetTreeOutput {
    @required
    root: TreeNode
}

structure TreeNode {
    @required
    id: String

    @required
    label: String

    children: TreeNodeList
}

list TreeNodeList {
    member: TreeNode
}
