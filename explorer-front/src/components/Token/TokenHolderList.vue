<template>
    <el-table :data="database" style="width: 100%">
        <el-table-column label="地址" width="500">
            <template slot-scope="scope">
                <router-link
                    :to="{
                        path: '/account/' + scope.row.account
                    }"
                >{{ scope.row.account }}</router-link>
            </template>
        </el-table-column>
        <el-table-column label="数量" align="right">
            <template slot-scope="scope">
                <span>{{ scope.row.balance | toTokenVal }}</span>
            </template>
        </el-table-column>
    </el-table>
</template>
<script>
export default {
    name: "TokenHolderList",
    props: ["database"]
};
</script>
